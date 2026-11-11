"""Tests of stt/kuyruk.py (stdlib only; run by test/sesli-komut-python.test.js: python -I -m unittest)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kuyruk import Held, JobQueue  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


class JobQueueTest(unittest.TestCase):
    def test_verify_goes_first(self):
        q = JobQueue(clock=Clock())
        q.put_utt(1, "g:a", b"x")
        q.put_verify(7)
        self.assertEqual(q.get(), ("verify", 7))
        self.assertEqual(q.get()[:3], ("utt", 1, "g:a"))

    def test_full_queue_drops_the_oldest(self):
        q = JobQueue(max_utts=2, clock=Clock())
        self.assertIsNone(q.put_utt(1, "g:a", b""))
        self.assertIsNone(q.put_utt(2, "g:b", b""))
        self.assertEqual(q.put_utt(3, "g:c", b""), (1, "g:a"))
        self.assertEqual([q.get()[1], q.get()[1]], [2, 3])

    def test_old_sentences_are_dropped_when_taken(self):
        clock = Clock()
        q = JobQueue(max_age=4.0, clock=clock)
        q.put_utt(1, "g:a", b"")
        clock.t += 4.5
        q.put_utt(2, "g:a", b"")
        self.assertEqual(q.get(), ("stale", 1, "g:a"))
        self.assertEqual(q.get()[:2], ("utt", 2))

    def test_drop_key_and_close(self):
        q = JobQueue(clock=Clock())
        q.put_utt(1, "g:a", b"")
        q.put_utt(2, "g:b", b"")
        self.assertEqual(q.drop_key(lambda k: k == "g:a"), 1)
        self.assertEqual(q.get()[1], 2)
        self.assertEqual(q.get(timeout=0.01), ("timeout",))
        q.close()
        self.assertIsNone(q.get())


class HeldTest(unittest.TestCase):
    def test_taken_once(self):
        h = Held(clock=Clock())
        h.put(1, "g:a", b"pcm", "müzik bot")
        self.assertEqual(h.take(1), ("g:a", b"pcm", "müzik bot"))
        self.assertIsNone(h.take(1))

    def test_forgotten_after_hold_time(self):
        clock = Clock()
        h = Held(hold_sec=15, clock=clock)
        h.put(1, "g:a", b"pcm", "w")
        clock.t += 16
        h.expire()
        self.assertEqual(len(h), 0)
        self.assertIsNone(h.take(1))

    def test_drop_key_and_limit(self):
        h = Held(max_items=2, clock=Clock())
        h.put(1, "g:a", b"", "w")
        h.put(2, "g:b", b"", "w")
        h.put(3, "g:b", b"", "w")
        self.assertIsNone(h.take(1), "the oldest went when full")
        h.drop_key(lambda k: k == "g:b")
        self.assertEqual(len(h), 0)


if __name__ == "__main__":
    unittest.main()
