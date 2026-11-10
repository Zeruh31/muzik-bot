import { api, el, formatDuration, initHeader, safeUrl, toast } from './common.js';

const guildId = window.location.pathname.split('/').filter(Boolean)[1];
const $ = (id) => document.getElementById(id);
const REPEAT_LABELS = { off: 'Kapalı', track: 'Şarkı', queue: 'Kuyruk' };
const NEXT_REPEAT = { off: 'track', track: 'queue', queue: 'off' };

let view = null;
let busy = false;
let volumeTimer = null;

function setControlsEnabled(enabled) {
  // While a request is running only buttons are locked, so typing in the search box is not lost.
  for (const node of document.querySelectorAll('[data-control]')) {
    node.disabled = !enabled || (busy && node.tagName === 'BUTTON');
  }
}

function currentPosition() {
  const state = view?.state;
  if (!state?.current) return 0;
  let position = state.position;
  if (state.playing && !state.paused) position += Date.now() - state.positionAt;
  return state.current.isStream ? position : Math.min(position, state.current.duration);
}

function renderProgress() {
  const track = view?.state?.current;
  if (!track) return;
  const position = currentPosition();
  $('np-pos').textContent = formatDuration(position);
  if (track.isStream) {
    $('np-dur').textContent = '🔴 Canlı';
    $('np-bar').style.width = '100%';
  } else {
    $('np-dur').textContent = formatDuration(track.duration);
    $('np-bar').style.width = `${track.duration ? Math.min(100, (position / track.duration) * 100) : 0}%`;
  }
}

function render(next) {
  view = next;
  const { guild, state, access } = view;
  document.title = `${guild.name} · Müzik Bot Paneli`;
  $('guild-name').textContent = guild.name;

  const accessBox = $('access');
  if (access.canControl) {
    accessBox.classList.add('hidden');
  } else {
    accessBox.textContent = `👀 İzleme modundasınız. ${access.reason ?? ''}`;
    accessBox.classList.remove('hidden');
  }

  const current = state?.current ?? null;
  $('now').classList.toggle('hidden', !current);
  $('idle').classList.toggle('hidden', Boolean(current));
  if (current) {
    const link = $('np-title');
    link.textContent = current.title;
    const href = safeUrl(current.uri);
    if (href) link.setAttribute('href', href);
    else link.removeAttribute('href');
    $('np-author').textContent = current.author;
    const art = safeUrl(current.artworkUrl);
    $('np-art').classList.toggle('hidden', !art);
    if (art) $('np-art').src = art;
    renderProgress();
  }

  const paused = Boolean(state?.paused);
  $('btn-toggle').textContent = paused ? '▶ Devam' : '⏸ Duraklat';
  $('btn-loop').textContent = `🔁 Tekrar: ${REPEAT_LABELS[state?.repeatMode ?? 'off']}`;
  if (state && document.activeElement !== $('volume')) {
    $('volume').value = String(state.volume);
    $('volume-value').textContent = String(state.volume);
  }

  const queue = state?.queue ?? [];
  $('queue-empty').classList.toggle('hidden', queue.length > 0);
  $('queue-info').textContent = queue.length ? `(${queue.length} şarkı, ${formatDuration(state.queueDuration)})` : '';
  $('queue').replaceChildren(
    ...queue.map((track, index) =>
      el(
        'li',
        {},
        el('span', { class: 'pos' }, String(index + 1)),
        el('div', { class: 't' }, el('span', {}, track.title), el('span', { class: 'a' }, track.author)),
        el('span', { class: 'dur' }, track.isStream ? 'Canlı' : formatDuration(track.duration)),
        el(
          'button',
          {
            class: 'small danger',
            type: 'button',
            'data-control': true,
            'aria-label': `${index + 1}. şarkıyı kuyruktan çıkar`,
            onclick: () => act('remove', { position: index + 1 }, 'Kuyruktan çıkarıldı.'),
          },
          '✕',
        ),
      ),
    ),
  );

  const hasPlayer = Boolean(state);
  setControlsEnabled(access.canControl);
  // Player controls only make sense while something is loaded; adding songs works anyway.
  for (const id of ['btn-toggle', 'btn-skip', 'btn-stop', 'btn-shuffle', 'btn-loop', 'volume']) {
    if (!hasPlayer || !current) $(id).disabled = true;
  }
  if (queue.length < 2) $('btn-shuffle').disabled = true;
}

async function act(action, body, successMessage) {
  if (busy) return;
  busy = true;
  setControlsEnabled(false);
  try {
    const result = await api(`/api/guilds/${encodeURIComponent(guildId)}/actions/${action}`, {
      method: 'POST',
      body: body ?? {},
    });
    if (successMessage) toast(typeof successMessage === 'function' ? successMessage(result) : successMessage);
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy = false;
    if (view) render(view);
  }
}

$('btn-toggle').addEventListener('click', () => act(view?.state?.paused ? 'resume' : 'pause'));
$('btn-skip').addEventListener('click', () => act('skip', undefined, 'Atlandı.'));
$('btn-stop').addEventListener('click', () => {
  if (window.confirm('Müzik durdurulsun, kuyruk temizlensin ve bot kanaldan ayrılsın mı?')) act('stop');
});
$('btn-shuffle').addEventListener('click', () => act('shuffle', undefined, 'Kuyruk karıştırıldı.'));
$('btn-loop').addEventListener('click', () => act('loop', { mode: NEXT_REPEAT[view?.state?.repeatMode ?? 'off'] }));

$('volume').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  $('volume-value').textContent = String(value);
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => act('volume', { volume: value }), 350);
});

$('add').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('query');
  const query = input.value.trim();
  if (!query) return;
  act('play', { query }, (result) => {
    input.value = '';
    return result.kind === 'playlist'
      ? `Çalma listesi eklendi: ${result.title ?? ''} (${result.added} şarkı)`
      : `Eklendi: ${result.title ?? 'şarkı'}`;
  });
});

function connect() {
  const source = new EventSource(`/api/guilds/${encodeURIComponent(guildId)}/events`);
  // "state" carries the full queue; "status" is the same without it (the queue did not change).
  source.addEventListener('state', (event) => {
    $('connection').classList.add('hidden');
    render(JSON.parse(event.data));
  });
  source.addEventListener('status', (event) => {
    $('connection').classList.add('hidden');
    const data = JSON.parse(event.data);
    render({ ...data, state: data.state ? { ...data.state, queue: view?.state?.queue ?? [] } : null });
  });
  // The server re-checks membership while connected; stop for good when it is gone.
  source.addEventListener('revoked', (event) => {
    source.close();
    const { error } = JSON.parse(event.data);
    $('connection').textContent = error ?? 'Bu sunucuyu görüntüleme izniniz kalmadı.';
    $('connection').classList.remove('hidden');
    setControlsEnabled(false);
  });
  source.addEventListener('error', async () => {
    $('connection').textContent = 'Canlı bağlantı koptu, yeniden bağlanılıyor…';
    $('connection').classList.remove('hidden');
    if (source.readyState === EventSource.CLOSED) {
      // The server refused (e.g. not a member any more): show why, retry later.
      try {
        render(await api(`/api/guilds/${encodeURIComponent(guildId)}`));
        setTimeout(connect, 5000);
      } catch (error) {
        $('connection').textContent = error.message;
      }
    }
  });
}

setInterval(renderProgress, 1000);

try {
  await initHeader();
  render(await api(`/api/guilds/${encodeURIComponent(guildId)}`));
  connect();
} catch (error) {
  $('guild-name').textContent = 'Sunucu açılamadı';
  $('connection').textContent = error.message;
  $('connection').classList.remove('hidden');
  setControlsEnabled(false);
}
