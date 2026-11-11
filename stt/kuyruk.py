"""Job queue and held audio of the speech worker (stdlib only, tested by stt/test_kuyruk.py).

Rules (a late command is worse than no command):
  - second-pass requests ("verify") always go first;
  - at most `max_utts` sentences wait; when full, the OLDEST waiting one is dropped, not the new one;
  - a sentence that waited longer than `max_age` seconds is dropped when taken (it would act on a later song);
  - audio held for the second pass is forgotten after `hold_sec` seconds, or at once when its speaker leaves,
    excludes themselves or the bot leaves the server ("end" / "endGuild").
"""

import collections
import threading
import time


class JobQueue:
    def __init__(self, max_utts=4, max_age=4.0, clock=time.monotonic):
        self.max_utts = max_utts
        self.max_age = max_age
        self.clock = clock
        self._utts = collections.deque()  # (uid, key, audio, ended_at)
        self._verifies = collections.deque()  # uid
        self._closed = False
        self._cv = threading.Condition()

    def put_utt(self, uid, key, audio, ended_at=None):
        """Queues a sentence; returns the (uid, key) of a sentence dropped to make room, or None."""
        with self._cv:
            dropped = None
            if len(self._utts) >= self.max_utts:
                old = self._utts.popleft()
                dropped = (old[0], old[1])
            self._utts.append((uid, key, audio, self.clock() if ended_at is None else ended_at))
            self._cv.notify()
            return dropped

    def put_verify(self, uid):
        with self._cv:
            self._verifies.append(uid)
            self._cv.notify()

    def drop_key(self, predicate):
        """Removes waiting sentences whose key matches; returns how many."""
        with self._cv:
            before = len(self._utts)
            self._utts = collections.deque(u for u in self._utts if not predicate(u[1]))
            return before - len(self._utts)

    def close(self):
        with self._cv:
            self._closed = True
            self._cv.notify_all()

    def size(self):
        with self._cv:
            return len(self._utts) + len(self._verifies)

    def get(self, timeout=None):
        """Next job: ("verify", uid) | ("utt", uid, key, audio, ended_at) | ("stale", uid, key) | None (closed)."""
        with self._cv:
            while not self._verifies and not self._utts and not self._closed:
                if not self._cv.wait(timeout):
                    return ("timeout",)
            if self._verifies:
                return ("verify", self._verifies.popleft())
            if self._utts:
                uid, key, audio, ended_at = self._utts.popleft()
                if self.clock() - ended_at > self.max_age:
                    return ("stale", uid, key)
                return ("utt", uid, key, audio, ended_at)
            return None


class Held:
    """Audio of recent sentences kept for the second pass."""

    def __init__(self, hold_sec=15.0, max_items=8, clock=time.monotonic):
        self.hold_sec = hold_sec
        self.max_items = max_items
        self.clock = clock
        self._items = collections.OrderedDict()  # uid -> (key, audio, wake, at)
        self._lock = threading.Lock()

    def _expire(self):
        now = self.clock()
        for uid in [u for u, v in self._items.items() if now - v[3] > self.hold_sec]:
            del self._items[uid]

    def put(self, uid, key, audio, wake):
        with self._lock:
            self._expire()
            self._items[uid] = (key, audio, wake, self.clock())
            while len(self._items) > self.max_items:
                self._items.popitem(last=False)

    def peek(self, uid):
        """The held (key, audio, wake) of a sentence, kept for a further pass; None when gone or too old."""
        with self._lock:
            self._expire()
            item = self._items.get(uid)
            return item[:3] if item else None

    def take(self, uid):
        """The held (key, audio, wake) of a sentence, once; None when gone or too old."""
        with self._lock:
            self._expire()
            item = self._items.pop(uid, None)
            return item[:3] if item else None

    def drop_key(self, predicate):
        with self._lock:
            for uid in [u for u, v in self._items.items() if predicate(v[0])]:
                del self._items[uid]

    def expire(self):
        with self._lock:
            self._expire()

    def __len__(self):
        with self._lock:
            return len(self._items)
