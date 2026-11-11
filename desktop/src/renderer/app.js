'use strict';

// Window logic. Talks to the main process only through window.muzik (see preload.js).
// All text from the bot and Lavalink is inserted with textContent, never as HTML.

const api = window.muzik;

// ---- tiny DOM helper -------------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const $ = (selector) => document.querySelector(selector);

function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

function openLink(url) {
  api.openExternal(url).then((ok) => {
    if (!ok) toast('Bu bağlantı güvenlik nedeniyle açılmadı.', 'bad');
  });
}

// ---- navigation ------------------------------------------------------------------------

function showView(name) {
  for (const item of document.querySelectorAll('.nav-item'))
    item.classList.toggle('active', item.dataset.view === name);
  for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === `view-${name}`);
  if (name === 'logs') renderLogs();
  if (name === 'servers') renderServers();
  if (name === 'stats') renderStats();
  if (name === 'settings' && !form.loaded) loadSettings();
}
for (const item of document.querySelectorAll('.nav-item'))
  item.addEventListener('click', () => showView(item.dataset.view));

// ---- status ----------------------------------------------------------------------------

const LAVALINK_LABELS = {
  stopped: ['Kapalı', ''],
  starting: ['Açılıyor', 'busy'],
  ready: ['Hazır', 'ok'],
  stopping: ['Kapanıyor', 'busy'],
  error: ['Hata', 'bad'],
  restarting: ['Yeniden denenecek', 'warn'],
};
const BOT_LABELS = {
  stopped: ['Kapalı', ''],
  starting: ['Bağlanıyor', 'busy'],
  ready: ['Çevrimiçi', 'ok'],
  stopping: ['Kapanıyor', 'busy'],
  error: ['Hata', 'bad'],
  restarting: ['Yeniden denenecek', 'warn'],
};

let status = null;
let lastYoutubeCode = null;

function setPill(card, [text, kind]) {
  const pill = card.querySelector('[data-role=pill]');
  pill.textContent = text;
  pill.className = `pill ${kind}`;
}

function setBody(card, ...nodes) {
  card.querySelector('[data-role=body]').replaceChildren(...nodes.filter(Boolean));
}

function setActions(card, ...nodes) {
  card.querySelector('[data-role=actions]')?.replaceChildren(...nodes.filter(Boolean));
}

function renderStatus(next) {
  status = next;
  $('#project-path').textContent = next.projectDir ?? 'bulunamadı';

  // Power button and headline
  const power = $('#power');
  const running = next.running;
  // While starting, the button stays usable: it cancels the start.
  const starting = next.busy === 'starting';
  power.classList.toggle('stop', running || starting);
  power.classList.toggle('working', Boolean(next.busy));
  power.disabled = next.busy === 'stopping' || !next.projectDir;
  $('#power-label').textContent = next.busy === 'stopping' ? 'Kapanıyor' : running || starting ? 'Durdur' : 'Başlat';

  let title = 'Bot kapalı';
  let sub = "Başlat'a basınca önce Lavalink, hazır olunca bot açılır.";
  if (next.busy === 'stopping') [title, sub] = ['Kapatılıyor...', 'Önce bot, sonra Lavalink düzgünce kapatılıyor.'];
  else if (next.bot.state === 'ready') [title, sub] = ['Bot çevrimiçi', `${next.bot.name ?? ''} Discord'da hazır.`];
  else if (next.lavalink.state === 'starting')
    [title, sub] = ['Lavalink açılıyor...', 'Bu ilk seferde biraz sürebilir (eklentiler indirilir).'];
  else if (next.bot.state === 'starting')
    [title, sub] = ["Discord'a bağlanılıyor...", 'Discord ağınızda engelliyse erişim aracınız (VPN vb.) açık olmalı.'];
  else if (next.lavalink.state === 'ready' && next.bot.state !== 'ready')
    [title, sub] = ['Lavalink hazır, bot kapalı', 'Bot hatasına aşağıdan bakın.'];
  else if (running) [title, sub] = ['Çalışıyor', ''];
  $('#hero-title').textContent = title;
  $('#hero-sub').textContent = sub;

  const errors = [];
  if (!next.projectDir)
    errors.push("Botun proje klasörü bulunamadı. Ayarlar > Proje klasörü > Değiştir ile 'Müzik Bot' klasörünü seçin.");
  if (next.lavalink.error && ['error', 'restarting'].includes(next.lavalink.state))
    errors.push(`Lavalink: ${next.lavalink.error}`);
  if (next.bot.error && ['error', 'restarting'].includes(next.bot.state)) errors.push(`Bot: ${next.bot.error}`);
  if (next.lastError && !errors.some((e) => e.includes(next.lastError))) errors.push(next.lastError);
  const errorBox = $('#hero-error');
  errorBox.textContent = errors.join('\n');
  errorBox.classList.toggle('hidden', errors.length === 0);

  // Lavalink card
  const lav = $('#card-lavalink');
  setPill(lav, LAVALINK_LABELS[next.lavalink.state] ?? ['?', '']);
  setBody(
    lav,
    h('div', {}, 'Port: ', h('strong', { text: next.lavalink.port ?? '?' })),
    next.lavalink.pid
      ? h('div', { text: `İşlem no (PID): ${next.lavalink.pid}${next.lavalink.adopted ? ' (devralındı)' : ''}` })
      : null,
    next.lavalink.detail ? h('div', { text: next.lavalink.detail }) : null,
  );

  // Bot card
  const bot = $('#card-bot');
  setPill(bot, BOT_LABELS[next.bot.state] ?? ['?', '']);
  const botLines = [];
  if (next.bot.name) botLines.push(h('div', {}, 'Bot: ', h('strong', { text: next.bot.name })));
  // Only next to "Çevrimiçi": never "Kapalı" and "şu an N sunucuda çalıyor" together.
  const live = next.bot.state === 'ready' && botData.status && !botData.stale ? botData.status : null;
  if (live) {
    // From data/durum.json: current numbers, not only those printed at login.
    botLines.push(
      h('div', {
        text: `${fmtNumber(live.bot.guildCount)} sunucuda · şu an ${fmtNumber(live.playingCount)} sunucuda çalıyor`,
      }),
    );
  } else if (next.bot.guilds !== null && next.bot.guilds !== undefined) {
    botLines.push(h('div', { text: `${next.bot.guilds} sunucuda` }));
  }
  if (next.bot.state === 'ready')
    botLines.push(
      h('div', { text: next.bot.lavalinkConnected ? 'Lavalink bağlantısı: var' : 'Lavalink bağlantısı bekleniyor' }),
    );
  if (next.bot.detail) botLines.push(h('div', { text: next.bot.detail }));
  if (!botLines.length) botLines.push(h('div', { text: 'Discord bağlantısı' }));
  setBody(bot, ...botLines);

  // YouTube card
  const yt = $('#card-youtube');
  const ytPhase = next.youtube.phase;
  if (next.youtube.loggedIn) setPill(yt, ['Giriş var', 'ok']);
  else if (ytPhase === 'code') setPill(yt, ['Kod bekliyor', 'warn']);
  else setPill(yt, ['Giriş yok', 'warn']);
  setBody(
    yt,
    h('div', {
      text: next.youtube.loggedIn
        ? "Lavalink YouTube'a yan hesapla giriş yapıyor."
        : ytPhase === 'code'
          ? `Giriş kodu: ${next.youtube.code}`
          : 'Lavalink açılınca giriş kodu burada görünür. YAN bir Google hesabı kullanın.',
    }),
  );
  setActions(
    yt,
    ['code', 'success', 'saved', 'error', 'waiting'].includes(ytPhase)
      ? h('button', {
          class: 'btn small',
          type: 'button',
          text: 'Giriş penceresini aç',
          onclick: () => openYoutubeModal(true),
        })
      : null,
  );

  // Panel card
  const panel = $('#card-panel');
  const p = next.panel;
  if (!p.enabled) setPill(panel, ['Kapalı', '']);
  else if (p.state === 'open') setPill(panel, ['Açık', 'ok']);
  else if (p.state === 'waiting') setPill(panel, ['Bekleniyor', 'busy']);
  else if (p.state === 'error') setPill(panel, ['Hata', 'bad']);
  else setPill(panel, ['Bot kapalı', '']);
  setBody(
    panel,
    p.enabled
      ? h('div', {}, 'Adres: ', h('strong', { text: p.url }))
      : h('div', { text: 'Ayarlar > Web paneli bölümünden açılabilir.' }),
    p.message ? h('div', { text: p.message }) : null,
  );
  setActions(
    panel,
    p.enabled
      ? h('button', {
          class: 'btn small',
          type: 'button',
          text: 'Tarayıcıda aç',
          disabled: p.state !== 'open',
          onclick: () => openLink(p.url),
        })
      : null,
  );

  renderWelcome(next);
  renderConflict(next.conflict);

  // YouTube wizard follows the phase.
  if (ytPhase === 'code' && next.youtube.code !== lastYoutubeCode) {
    lastYoutubeCode = next.youtube.code;
    openYoutubeModal(true);
  }
  if (!$('#yt-modal').classList.contains('hidden')) renderYoutubeModal();
}

$('#power').addEventListener('click', async () => {
  if (!status) return;
  const stop = status.running || status.busy === 'starting';
  try {
    renderStatus(await (stop ? api.stop() : api.start()));
  } catch (error) {
    toast(error.message, 'bad');
  }
});

// ---- another copy of the bot is running -------------------------------------------------

function conflictButtons() {
  return [
    h('button', {
      class: 'btn primary',
      type: 'button',
      text: 'Kapat ve buradan başlat',
      onclick: async () => {
        $('#conflict-modal').classList.add('hidden');
        renderStatus(await api.start({ takeOver: true }));
      },
    }),
    h('button', {
      class: 'btn ghost',
      type: 'button',
      text: 'Vazgeç',
      onclick: async () => renderStatus(await api.dismissConflict()),
    }),
  ];
}

function renderConflict(conflict) {
  const modal = $('#conflict-modal');
  const banner = $('#conflict-banner');
  if (!conflict) {
    modal.classList.add('hidden');
    banner.replaceChildren();
    return;
  }
  const text = `${conflict.message} Aynı bot iki kez açılırsa her komuta iki kez yanıt verir.`;
  if (conflict.startup || conflict.auto) {
    // On app start / autostart: inform, do not interrupt.
    modal.classList.add('hidden');
    banner.replaceChildren(
      h('div', { class: 'banner error' }, h('span', { class: 'grow', text }), ...conflictButtons()),
    );
  } else {
    banner.replaceChildren();
    $('#conflict-text').textContent = text;
    $('#conflict-actions').replaceChildren(...conflictButtons());
    modal.classList.remove('hidden');
  }
}

// ---- first start: choose the project folder -------------------------------------------------

function renderWelcome(next) {
  $('#welcome').classList.toggle('hidden', Boolean(next.projectDir));
}

$('#welcome-choose').addEventListener('click', async () => {
  const result = await api.chooseProject();
  if (result.canceled) return;
  $('#welcome-error').textContent = result.ok ? '' : (result.message ?? 'Klasör kullanılamadı.');
  $('#welcome-error').classList.toggle('hidden', result.ok);
  renderStatus(await api.status());
});

// ---- YouTube wizard ------------------------------------------------------------------------

function openYoutubeModal(show) {
  $('#yt-modal').classList.toggle('hidden', !show);
  if (show) renderYoutubeModal();
}

function renderYoutubeModal() {
  const yt = status?.youtube ?? { phase: 'idle' };
  const body = $('#yt-body');
  const warn = h(
    'div',
    { class: 'alert warn' },
    h('strong', { text: 'Ana Google hesabınızı KULLANMAYIN. ' }),
    'Bu iş için yeni, önemsiz bir YAN hesap açın. YouTube bu kullanımı fark edip hesabı kapatabilir.',
  );
  if (yt.phase === 'code') {
    body.replaceChildren(
      h('p', { class: 'muted', text: "Lavalink YouTube'a giriş yapmak için izin istiyor:" }),
      h(
        'ol',
        { class: 'steps' },
        h('li', { text: '"google.com/device\'ı aç" düğmesine basın.' }),
        h('li', { text: 'Aşağıdaki kodu girin ve YAN hesabınızla izin verin.' }),
        h('li', { text: 'Birkaç saniye içinde token kendiliğinden kaydedilir.' }),
      ),
      h(
        'div',
        { class: 'code-box' },
        h('span', { class: 'code', text: yt.code }),
        h('button', {
          class: 'btn',
          type: 'button',
          text: 'Kopyala',
          onclick: () => api.copy(yt.code).then(() => toast('Kod kopyalandı.', 'ok')),
        }),
      ),
      warn,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', {
          class: 'btn primary',
          type: 'button',
          text: "google.com/device'ı aç",
          onclick: () => openLink(yt.url || 'https://www.google.com/device'),
        }),
        h('span', { class: 'muted small' }, h('span', { class: 'spinner' }), ' Giriş bekleniyor...'),
      ),
    );
  } else if (yt.phase === 'success') {
    body.replaceChildren(
      h('p', {}, h('span', { class: 'spinner' }), ' Giriş başarılı. Token .env dosyasına kaydediliyor...'),
    );
  } else if (yt.phase === 'saved') {
    body.replaceChildren(
      h('div', { class: 'alert info', text: yt.message ?? 'Token kaydedildi.' }),
      h('p', {
        class: 'muted',
        text: "Lavalink'i şimdi yeniden başlatırsanız kayıtlı girişle açılır; bir daha kod sorulmaz.",
      }),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', {
          class: 'btn primary',
          type: 'button',
          text: "Lavalink'i yeniden başlat",
          onclick: async () => {
            openYoutubeModal(false);
            await api.dismissYoutube();
            renderStatus(await api.restart('hepsi'));
          },
        }),
        h('button', {
          class: 'btn ghost',
          type: 'button',
          text: 'Sonra',
          onclick: async () => {
            openYoutubeModal(false);
            await api.dismissYoutube();
          },
        }),
      ),
    );
  } else if (yt.phase === 'error') {
    body.replaceChildren(
      h('div', { class: 'alert error', text: yt.message ?? 'Token kaydedilemedi.' }),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', {
          class: 'btn primary',
          type: 'button',
          text: 'Tekrar dene',
          onclick: async () => {
            const result = await api.saveYoutubeToken();
            toast(result.message, result.ok ? 'ok' : 'bad');
          },
        }),
      ),
    );
  } else if (yt.phase === 'waiting') {
    body.replaceChildren(h('p', {}, h('span', { class: 'spinner' }), ' Lavalink giriş kodunu hazırlıyor...'), warn);
  } else {
    body.replaceChildren(
      h('p', {
        class: 'muted',
        text: status?.youtube?.loggedIn
          ? 'YouTube girişi yapılmış.'
          : "Lavalink'i başlatınca giriş kodu burada görünecek.",
      }),
    );
  }
}

$('#yt-close').addEventListener('click', () => openYoutubeModal(false));
$('#yt-modal').addEventListener('click', (event) => {
  if (event.target.id === 'yt-modal') openYoutubeModal(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') openYoutubeModal(false);
});

// ---- logs ------------------------------------------------------------------------------

const LOG_LIMIT = 5000;
const RENDER_LIMIT = 1500;
const SOURCE_LABELS = { bot: 'bot', lavalink: 'lavalink', app: 'uygulama' };
const LEVEL_LABELS = { debug: 'DEBUG', info: 'BİLGİ', warn: 'UYARI', error: 'HATA' };
const logState = { entries: [], source: '', level: '', search: '' };

function logMatches(entry) {
  if (logState.source && entry.source !== logState.source) return false;
  if (logState.level === 'warn' && !['warn', 'error'].includes(entry.level)) return false;
  if (logState.level === 'error' && entry.level !== 'error') return false;
  if (logState.search && !entry.text.toLocaleLowerCase('tr').includes(logState.search)) return false;
  return true;
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('tr-TR', { hour12: false });
}

function logRow(entry) {
  return h(
    'div',
    { class: `log-row ${entry.level}` },
    h('span', { class: 'log-time', text: formatTime(entry.time) }),
    h('span', { class: `log-src ${entry.source}`, text: SOURCE_LABELS[entry.source] ?? entry.source }),
    h('span', { class: `log-lvl ${entry.level}`, text: LEVEL_LABELS[entry.level] ?? entry.level }),
    h('span', { class: 'log-text', text: entry.text }),
  );
}

function visibleLogs() {
  return logState.entries.filter(logMatches);
}

function renderLogs() {
  const list = $('#log-list');
  const matching = visibleLogs();
  const shown = matching.slice(-RENDER_LIMIT);
  list.replaceChildren(
    ...(shown.length ? shown.map(logRow) : [h('div', { class: 'log-empty', text: 'Gösterilecek kayıt yok.' })]),
  );
  $('#log-count').textContent =
    matching.length > shown.length
      ? `${matching.length} kaydın son ${shown.length} tanesi gösteriliyor.`
      : `${matching.length} kayıt`;
  if ($('#log-follow').checked) list.scrollTop = list.scrollHeight;
}

function appendLogs(batch) {
  logState.entries.push(...batch);
  if (logState.entries.length > LOG_LIMIT) logState.entries.splice(0, logState.entries.length - LOG_LIMIT);
  if (!$('#view-logs').classList.contains('active')) return;
  const list = $('#log-list');
  const fresh = batch.filter(logMatches);
  if (!fresh.length) return;
  list.querySelector('.log-empty')?.remove();
  list.append(...fresh.map(logRow));
  while (list.childElementCount > RENDER_LIMIT) list.firstElementChild.remove();
  $('#log-count').textContent = `${visibleLogs().length} kayıt`;
  if ($('#log-follow').checked) list.scrollTop = list.scrollHeight;
}

function bindSegmented(id, key, attr) {
  const group = $(id);
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    for (const b of group.querySelectorAll('button')) b.classList.toggle('active', b === button);
    logState[key] = button.dataset[attr];
    renderLogs();
  });
}
bindSegmented('#log-source', 'source', 'source');
bindSegmented('#log-level', 'level', 'level');

let searchTimer = null;
$('#log-search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    logState.search = event.target.value.trim().toLocaleLowerCase('tr');
    renderLogs();
  }, 180);
});
$('#log-copy').addEventListener('click', async () => {
  const text = visibleLogs()
    .map(
      (e) =>
        `${formatTime(e.time)} ${SOURCE_LABELS[e.source] ?? e.source} ${LEVEL_LABELS[e.level] ?? e.level} ${e.text}`,
    )
    .join('\n');
  await api.copy(text);
  toast('Görünen kayıtlar panoya kopyalandı.', 'ok');
});
$('#log-folder').addEventListener('click', () => api.openLogFolder());
$('#log-clear').addEventListener('click', async () => {
  await api.clearLogs();
  logState.entries = [];
  renderLogs();
});

// ---- settings ----------------------------------------------------------------------------

const form = { loaded: false, original: {}, inputs: new Map(), groups: [] };

function fieldValue(key) {
  const input = form.inputs.get(key);
  if (!input) return undefined;
  if (input.type === 'checkbox') {
    // Leave an empty value alone until the user flips the switch.
    if (input.dataset.touched !== '1' && (form.original[key] ?? '') === '') return '';
    return input.checked ? 'true' : 'false';
  }
  return input.value;
}

function changedValues() {
  const changes = {};
  for (const key of form.inputs.keys()) {
    const value = fieldValue(key);
    if (value !== (form.original[key] ?? '')) changes[key] = value;
  }
  return changes;
}

function updateSaveBar() {
  const count = Object.keys(changedValues()).length;
  $('#savebar').classList.toggle('dirty', count > 0);
  $('#savebar-text').textContent = count ? `${count} değişiklik kaydedilmedi.` : 'Değişiklik yok.';
  $('#env-save').disabled = count === 0;
  $('#env-revert').disabled = count === 0;
}

function buildField(field, value) {
  const id = `f-${field.key}`;
  let input;
  const extras = [];
  if (field.type === 'bool') {
    input = h('input', { type: 'checkbox', id });
    // An empty value means the bot's default applies; show that default.
    const effective = String(value ?? '').trim() === '' ? (field.default ?? '') : value;
    input.checked = ['1', 'true', 'evet', 'yes', 'on', 'acik', 'açık'].includes(String(effective).trim().toLowerCase());
    input.addEventListener('change', () => {
      input.dataset.touched = '1';
    });
  } else if (field.type === 'select') {
    input = h('select', { class: 'input', id });
    if (!field.options.some((o) => o.value === value))
      input.append(h('option', { value: value ?? '', text: value ? value : '(varsayılan)' }));
    for (const option of field.options) input.append(h('option', { value: option.value, text: option.label }));
    input.value = value ?? '';
  } else {
    input = h('input', {
      class: 'input',
      id,
      type: field.type === 'secret' ? 'password' : 'text',
      inputmode: field.type === 'number' ? 'numeric' : undefined,
      placeholder: field.placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
    });
    input.value = value ?? '';
    if (field.type === 'secret') {
      const eye = h('button', {
        class: 'btn icon',
        type: 'button',
        title: 'Göster / gizle',
        'aria-label': 'Göster / gizle',
        text: '👁',
      });
      eye.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
      });
      extras.push(eye);
    }
    if (field.generate) {
      extras.push(
        h('button', {
          class: 'btn',
          type: 'button',
          text: 'Üret',
          onclick: async () => {
            input.value = await api.generateSecret();
            input.dispatchEvent(new Event('input', { bubbles: true }));
          },
        }),
      );
    }
  }
  form.inputs.set(field.key, input);
  input.addEventListener('input', updateSaveBar);
  input.addEventListener('change', updateSaveBar);

  const control =
    field.type === 'bool'
      ? h('div', { class: 'field-input-row' }, h('label', { class: 'switch' }, input, h('span')))
      : h('div', { class: 'field-input-row' }, input, ...extras);

  return h(
    'div',
    { class: 'field' },
    h(
      'label',
      { for: id },
      h('div', { class: 'field-label', text: field.label }),
      h('div', { class: 'field-key', text: field.key }),
    ),
    h(
      'div',
      { class: 'field-control' },
      control,
      h('div', { class: 'field-help', text: field.help ?? '' }),
      field.link
        ? h('button', {
            class: 'link',
            type: 'button',
            text: `Nereden alınır? ${field.linkText ?? field.link} ↗`,
            onclick: () => openLink(field.link),
          })
        : null,
      h('div', { class: 'field-error hidden', id: `err-${field.key}` }),
    ),
  );
}

async function loadSettings() {
  const [env, options] = await Promise.all([api.readEnv(), api.appOptions()]);
  renderAppOptions(options);
  form.loaded = true;
  form.original = { ...env.values };
  form.revision = env.revision;
  form.inputs = new Map();
  const container = $('#env-form');
  const cards = [];
  if (!env.path) {
    cards.push(
      h('div', { class: 'alert error', text: 'Proje klasörü bulunamadı; .env düzenlenemez. Yukarıdan klasörü seçin.' }),
    );
  } else if (!env.exists) {
    cards.push(
      h('div', {
        class: 'alert warn',
        text: ".env dosyası yok. Kaydet'e basınca .env.example kopyalanarak oluşturulur.",
      }),
    );
  }
  if (env.path) {
    for (const group of env.groups) {
      cards.push(
        h(
          'article',
          { class: 'card form-card' },
          h('h2', { text: group.title }),
          h('p', { class: 'muted small', text: group.description }),
          ...group.fields.map((field) => buildField(field, env.values[field.key] ?? '')),
        ),
      );
    }
    if (env.extraKeys.length) {
      cards.push(
        h(
          'article',
          { class: 'card form-card' },
          h('h2', { text: 'Diğer' }),
          h('p', {
            class: 'muted small',
            text: "Bu formda ayrıca tanımlı olmayan ayarlar (.env ya da .env.example dosyasından). Açıklamalar .env.example'daki yorumlardır. Değiştirmedikleriniz olduğu gibi korunur.",
          }),
          ...env.extraKeys.map((key) =>
            buildField({ key, label: key, type: 'text', help: env.extraHelp?.[key] ?? '' }, env.values[key] ?? ''),
          ),
        ),
      );
    }
  }
  container.replaceChildren(...cards);
  updateSaveBar();
}

function renderAppOptions(options) {
  $('#opt-autostart').checked = options.autoStartBot;
  $('#opt-login').checked = options.openAtLogin;
  $('#opt-restart').checked = options.autoRestart;
  $('#opt-login').disabled = !options.isPackaged;
  if (!options.isPackaged)
    $('#opt-login-help').textContent =
      'Yalnız kurulmuş ya da taşınabilir exe ile kullanılabilir (geliştirme modunda kapalı).';
  $('#opt-project').textContent = options.projectDir ?? 'bulunamadı';
}

for (const [id, key] of [
  ['#opt-autostart', 'autoStartBot'],
  ['#opt-login', 'openAtLogin'],
  ['#opt-restart', 'autoRestart'],
]) {
  $(id).addEventListener('change', async (event) => {
    renderAppOptions(await api.saveAppOptions({ [key]: event.target.checked }));
    toast('Kaydedildi.', 'ok');
  });
}

async function afterProjectChange(result) {
  if (result.canceled) return;
  if (result.unchanged) {
    toast('Proje klasörü zaten bu; bir şey değişmedi.');
    return;
  }
  if (result.message) toast(result.message, 'bad');
  if (result.options) renderAppOptions(result.options);
  form.loaded = false;
  await loadSettings();
  renderStatus(await api.status());
}
$('#project-choose').addEventListener('click', async () => {
  const result = await api.chooseProject();
  if (!result.canceled) await afterProjectChange(result);
});
$('#project-reset').addEventListener('click', async () => afterProjectChange(await api.resetProject()));

$('#env-revert').addEventListener('click', () => {
  form.loaded = false;
  loadSettings();
});

$('#env-save').addEventListener('click', async () => {
  const changes = changedValues();
  for (const el of document.querySelectorAll('.field-error')) el.classList.add('hidden');
  for (const input of form.inputs.values()) input.classList.remove('invalid');
  const base = Object.fromEntries(Object.keys(changes).map((key) => [key, form.original[key] ?? '']));
  let result = await api.saveEnv({ changes, base, revision: form.revision });
  if (result.conflict) {
    // The same settings were changed outside the app since the form was opened.
    const overwrite = window.confirm(
      `.env dosyası siz formu açtıktan sonra dışarıdan değişmiş (ör. YouTube token kaydı ya da bir düzenleyici).\n\nŞu ayarlar ikisinde de değişti: ${result.conflictKeys.join(', ')}\n\nTamam: sizin değerleriniz yazılsın. İptal: formu yeniden yükleyip dışarıdaki değerleri görün.`,
    );
    if (!overwrite) {
      form.loaded = false;
      await loadSettings();
      return;
    }
    result = await api.saveEnv({ changes, base, revision: form.revision, force: true });
  }
  if (!result.ok) {
    for (const [key, message] of Object.entries(result.errors ?? {})) {
      const el = document.getElementById(`err-${key}`);
      if (el) {
        el.textContent = message;
        el.classList.remove('hidden');
        form.inputs.get(key)?.classList.add('invalid');
      } else {
        toast(message, 'bad');
      }
    }
    toast('Kaydedilemedi: işaretli alanları düzeltin.', 'bad');
    return;
  }
  toast(result.merged ? 'Ayarlar kaydedildi (dosyadaki dış değişiklikler korundu).' : 'Ayarlar kaydedildi.', 'ok');
  form.loaded = false;
  await loadSettings();
  if (result.restart?.lavalink || result.restart?.bot) showRestartBanner(result.restart);
});

// ---- banners ---------------------------------------------------------------------------

let restartNeed = null;
function showRestartBanner(need) {
  restartNeed = {
    lavalink: Boolean(need.lavalink || restartNeed?.lavalink),
    bot: Boolean(need.bot || restartNeed?.bot),
  };
  const what = restartNeed.lavalink ? 'bot ve Lavalink' : 'bot';
  const banner = h(
    'div',
    { class: 'banner' },
    h('span', { class: 'grow', text: `Ayarlar değişti. Etkili olması için ${what} yeniden başlatılmalı.` }),
    h('button', {
      class: 'btn primary',
      type: 'button',
      text: 'Şimdi yeniden başlat',
      onclick: async () => {
        const target = restartNeed.lavalink ? 'hepsi' : 'bot';
        restartNeed = null;
        banner.remove();
        renderStatus(await api.restart(target));
      },
    }),
    h('button', {
      class: 'btn ghost',
      type: 'button',
      text: 'Sonra',
      onclick: () => {
        restartNeed = null;
        banner.remove();
      },
    }),
  );
  $('#banners').replaceChildren(banner);
}

// ---- tools -----------------------------------------------------------------------------

async function runTool(button, resultEl, fn) {
  button.disabled = true;
  const label = button.textContent;
  button.replaceChildren(h('span', { class: 'spinner' }), ' Çalışıyor...');
  resultEl.replaceChildren();
  try {
    await fn();
  } catch (error) {
    resultEl.replaceChildren(h('div', { class: 'alert error', text: error.message }));
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$('#tool-deploy').addEventListener('click', (event) =>
  runTool(event.currentTarget, $('#tool-deploy-result'), async () => {
    const result = await api.deployCommands();
    $('#tool-deploy-result').replaceChildren(
      h('div', { class: `alert ${result.ok ? 'info' : 'error'}`, text: result.message }),
      result.output
        ? h(
            'details',
            { class: 'output' },
            h('summary', { text: 'Ayrıntılı çıktı' }),
            h('pre', { text: result.output }),
          )
        : null,
    );
  }),
);

$('#tool-check').addEventListener('click', (event) =>
  runTool(event.currentTarget, $('#tool-check-result'), async () => {
    const result = await api.checkSetup();
    const marks = { ok: '✓', warn: '!', bad: '✕' };
    $('#tool-check-result').replaceChildren(
      result.error ? h('div', { class: 'alert error', text: result.error }) : null,
      h(
        'ul',
        { class: 'check-list' },
        ...result.items.map((item) =>
          h(
            'li',
            {},
            h('span', { class: `mark ${item.status}`, text: marks[item.status] }),
            h('span', { text: item.text }),
          ),
        ),
      ),
      result.summary ? h('div', { class: `alert ${result.problems ? 'warn' : 'info'}`, text: result.summary }) : null,
    );
  }),
);

$('#tool-download').addEventListener('click', (event) =>
  runTool(event.currentTarget, $('#tool-download-result'), async () => {
    const progress = $('#tool-download-progress');
    progress.classList.remove('hidden');
    progress.firstElementChild.style.width = '0%';
    const result = await api.downloadLavalink();
    progress.classList.add('hidden');
    $('#tool-download-result').replaceChildren(
      h('div', { class: `alert ${result.ok ? 'info' : 'error'}`, text: result.message }),
    );
  }),
);

$('#tool-youtube').addEventListener('click', (event) =>
  runTool(event.currentTarget, $('#tool-youtube-result'), async () => {
    const result = await api.saveYoutubeToken();
    $('#tool-youtube-result').replaceChildren(
      h('div', { class: `alert ${result.ok ? 'info' : 'error'}`, text: result.message }),
    );
  }),
);

// ---- bot status file: servers and statistics ---------------------------------------------------
// Data comes from data/durum.json, already validated by the main process. Every server name
// and song title is user data: it only ever goes into textContent.

const SVG_NS = 'http://www.w3.org/2000/svg';
let botData = { status: null, stale: true, history: [] };
const serverView = { query: '', sort: 'name', selected: null };

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtUptime(ms) {
  const minutes = Math.floor((ms ?? 0) / 60000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return `${d} gün ${h} sa`;
  if (h) return `${h} sa ${m} dk`;
  return `${m} dk`;
}

const fmtMb = (bytes) => `${Math.round((bytes ?? 0) / 1048576)} MB`;
const fmtNumber = (n) => Number(n ?? 0).toLocaleString('tr-TR');
const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
const fmtDateTime = (ms) => new Date(ms).toLocaleString('tr-TR', { hour12: false });

/** "Bot kapalı" note shared by both tabs; null when the data is live. */
function staleText() {
  if (!botData.status) return "Henüz veri yok. Bot Discord'a bağlanınca sunucular ve istatistikler burada görünür.";
  if (!botData.stale) return null;
  return `Bot kapalı, son bilinen veriler: ${fmtDateTime(botData.status.updatedAt)}`;
}

function setStaleNote(id) {
  const text = staleText();
  const el = $(id);
  el.textContent = text ?? '';
  el.classList.toggle('hidden', !text);
}

/** Current position of a playing track: the file is a few seconds old, so move it forward. */
function livePosition(playing) {
  if (!playing) return 0;
  if (playing.paused || playing.isStream || botData.stale || !botData.status) return playing.positionMs;
  const elapsed = Date.now() - botData.status.updatedAt;
  return Math.min(playing.positionMs + Math.max(0, elapsed), playing.durationMs || Infinity);
}

function serverIcon(server, size = 'md') {
  if (server.iconUrl) return h('img', { class: `server-icon ${size}`, src: server.iconUrl, alt: '' });
  return h('div', {
    class: `server-icon ${size} initials`,
    'aria-hidden': 'true',
    text: window.serverList.initials(server.name),
  });
}

function playingBadge(server) {
  if (server.playing && !server.playing.paused) return h('span', { class: 'pill ok', text: 'Çalıyor' });
  if (server.playing) return h('span', { class: 'pill warn', text: 'Duraklatıldı' });
  return h('span', { class: 'pill', text: 'Boşta' });
}

function renderServers() {
  setStaleNote('#servers-stale');
  const all = botData.status?.servers ?? [];
  const list = window.serverList.sortServers(window.serverList.filterServers(all, serverView.query), serverView.sort);
  $('#server-count').textContent = all.length ? `${list.length} / ${all.length} sunucu` : '';
  const grid = $('#server-grid');
  if (!list.length) {
    grid.replaceChildren(
      h('div', { class: 'empty', text: all.length ? 'Aramaya uyan sunucu yok.' : 'Gösterilecek sunucu yok.' }),
    );
  } else {
    grid.replaceChildren(
      ...list.map((server) =>
        h(
          'button',
          {
            class: `server-card${server.id === serverView.selected ? ' selected' : ''}`,
            type: 'button',
            onclick: () => {
              serverView.selected = server.id;
              renderServers();
            },
          },
          serverIcon(server),
          h(
            'div',
            { class: 'server-meta' },
            h('div', { class: 'server-name', text: server.name }),
            h('div', {
              class: 'muted small',
              text: `${fmtNumber(server.memberCount)} üye · katılma ${fmtDate(server.joinedAt)}`,
            }),
          ),
          playingBadge(server),
        ),
      ),
    );
  }
  if (!all.some((s) => s.id === serverView.selected)) serverView.selected = list[0]?.id ?? null;
  renderServerDetail();
  syncServerSettings();
}

function detailRow(label, value) {
  return h('div', { class: 'detail-row' }, h('span', { class: 'muted', text: label }), h('span', { text: value }));
}

function renderServerDetail() {
  const box = $('#server-detail');
  const server = botData.status?.servers.find((s) => s.id === serverView.selected);
  if (!server) {
    box.replaceChildren(h('div', { class: 'muted', text: 'Ayrıntı için bir sunucu seçin.' }));
    return;
  }
  const p = server.playing;
  const repeat = { off: 'Kapalı', track: 'Şarkı', queue: 'Kuyruk' }[server.repeatMode];
  const nowPlaying = p
    ? h(
        'div',
        { class: 'now-playing' },
        h('div', { class: 'np-title', text: p.title }),
        h('div', { class: 'muted small', text: p.author }),
        p.isStream
          ? h('div', { class: 'muted small', text: 'Canlı yayın' })
          : h(
              'div',
              { class: 'np-progress' },
              h('div', { class: 'progress' }, h('div', { class: 'progress-bar', 'data-role': 'np-bar' })),
              h('div', { class: 'muted small np-time', 'data-role': 'np-time' }),
            ),
        p.uri
          ? h('button', { class: 'link', type: 'button', text: 'Şarkıyı aç ↗', onclick: () => openLink(p.uri) })
          : null,
      )
    : h('div', { class: 'muted', text: 'Şu an bir şey çalmıyor.' });
  box.replaceChildren(
    h(
      'div',
      { class: 'detail-head' },
      serverIcon(server, 'lg'),
      h('div', {}, h('h2', { text: server.name }), playingBadge(server)),
    ),
    nowPlaying,
    detailRow('Kuyruk', `${fmtNumber(server.queueLength)} şarkı`),
    detailRow(
      'Ses kanalı',
      server.voice ? `${server.voice.channelName ?? '?'} · ${server.voice.listeners} dinleyici` : 'Kanalda değil',
    ),
    detailRow('Döngü', repeat),
    detailRow('Ses seviyesi', server.volume === null ? '—' : `%${server.volume}`),
    detailRow('DJ rolü', server.djRole ? 'Ayarlı' : 'Yok'),
    detailRow('Bu sunucuda çalınan', `${fmtNumber(server.songsPlayed)} şarkı`),
    detailRow('Üye', fmtNumber(server.memberCount)),
    detailRow('Bot katıldı', fmtDate(server.joinedAt)),
  );
  updateProgress();
}

/** Moves the progress bar between file updates. */
function updateProgress() {
  const server = botData.status?.servers.find((s) => s.id === serverView.selected);
  const p = server?.playing;
  const bar = document.querySelector('[data-role=np-bar]');
  if (!p || !bar) return;
  const position = livePosition(p);
  bar.style.width = `${p.durationMs ? Math.min(100, (position / p.durationMs) * 100) : 0}%`;
  document.querySelector('[data-role=np-time]').textContent = `${fmtDuration(position)} / ${fmtDuration(p.durationMs)}`;
}
setInterval(() => {
  if ($('#view-servers').classList.contains('active')) updateProgress();
}, 1000);

$('#server-search').addEventListener('input', (event) => {
  serverView.query = event.target.value;
  renderServers();
});
$('#server-sort').addEventListener('change', (event) => {
  serverView.sort = event.target.value;
  renderServers();
});

// ---- server settings ("Ayarlar") ----------------------------------------------------------------
// The fields come from the bot's own schema (data/ayar-semasi.json), channels and roles from
// data/sunucu-yapisi.json, both checked by the main process. Names are user data: textContent only.
// Saving sends { guildId, modul, alan, deger } to the main process, which checks it again and hands it
// to the bot; the bot applies it with the same rules as /ayar and answers in Turkish.

const SS = window.serverSettings;
const settingsView = {
  guildId: null,
  data: null,
  live: null,
  loading: 0,
  edits: new Map(), // "modul.alan" -> value changed here but not saved yet
  status: new Map(), // "modul.alan" -> { kind, text } of the last save
  saving: new Set(),
};

const settingKey = (module, field) => `${module.ad}.${field.anahtar}`;
const isList = (field) => field.tur === 'kanal-listesi' || field.tur === 'rol-listesi';
/** A typed value that does not pass the checks yet (kept so the Save button stays off). */
const isInvalidEdit = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

async function loadServerSettings(guildId) {
  const ticket = ++settingsView.loading;
  const data = guildId ? await api.serverSettings(guildId) : null;
  if (ticket !== settingsView.loading || settingsView.guildId !== guildId) return; // another server meanwhile
  settingsView.data = data;
  renderServerSettings();
}

/** Called whenever the server list is drawn: reloads only when the server or the bot's state changed. */
function syncServerSettings() {
  const live = Boolean(botData.status && !botData.stale);
  if (settingsView.guildId !== serverView.selected) {
    settingsView.guildId = serverView.selected;
    settingsView.data = null;
    settingsView.edits.clear();
    settingsView.status.clear();
    settingsView.live = live;
    renderServerSettings();
    loadServerSettings(serverView.selected);
  } else if (settingsView.live !== live) {
    settingsView.live = live;
    renderServerSettings();
  }
}

function currentValue(module, field) {
  const key = settingKey(module, field);
  const view = settingsView.data?.gorunum;
  if (isList(field) || field.tur === 'ozel') return view?.listeler?.[key] ?? [];
  const value = view?.degerler?.[key];
  return value === undefined ? (field.varsayilan ?? null) : value;
}

function editedValue(module, field) {
  const key = settingKey(module, field);
  return settingsView.edits.has(key) ? settingsView.edits.get(key) : currentValue(module, field);
}

function pickerSelect(id, options, value, disabled, onChange) {
  const select = h('select', { class: 'input', id, disabled });
  select.append(h('option', { value: '', text: '(ayarlanmadı)' }));
  if (value && !options.some((o) => o.id === value)) select.append(h('option', { value, text: '(silinmiş öğe)' }));
  for (const o of options) {
    select.append(
      h('option', {
        value: o.id,
        text: o.reason ? `${o.label} (seçilemez: ${o.reason})` : o.warning ? `${o.label} ⚠` : o.label,
        disabled: o.disabled,
      }),
    );
  }
  select.value = value ?? '';
  select.addEventListener('change', () => onChange(select.value || null));
  return select;
}

function listControl(id, field, guild, items, disabled, onChange) {
  const choices =
    field.tur === 'kanal-listesi' ? SS.channelChoices(guild, field.kanalTurleri) : SS.roleChoices(guild, {});
  const chips = h(
    'div',
    { class: 'chip-list' },
    items.length ? null : h('span', { class: 'muted small', text: 'Liste boş.' }),
    ...items.map((itemId) =>
      h(
        'span',
        { class: 'chip' },
        h('span', { text: SS.nameOf(guild, itemId) }),
        h('button', {
          class: 'chip-x',
          type: 'button',
          title: 'Listeden çıkar',
          'aria-label': `${SS.nameOf(guild, itemId)}: listeden çıkar`,
          text: '×',
          disabled,
          onclick: () => onChange(items.filter((x) => x !== itemId)),
        }),
      ),
    ),
  );
  const full = items.length >= field.enFazla;
  const add = h('select', { class: 'input', id, disabled: disabled || full });
  add.append(h('option', { value: '', text: full ? 'Liste dolu' : '+ Ekle...' }));
  for (const o of choices) {
    if (items.includes(o.id)) continue;
    add.append(
      h('option', { value: o.id, text: o.reason ? `${o.label} (${o.reason})` : o.label, disabled: o.disabled }),
    );
  }
  add.addEventListener('change', () => add.value && onChange([...items, add.value]));
  return h('div', { class: 'list-control' }, chips, add);
}

function fieldRow(module, field) {
  const key = settingKey(module, field);
  const id = `set-${key.replace(/[^a-z0-9-]/g, '-')}`;
  const guild = settingsView.data?.yapi;
  const current = currentValue(module, field);
  const value = editedValue(module, field);
  const blocked = !settingsView.live || Boolean(settingsView.data?.saltOkunur) || Boolean(module.kapali);
  const error = h('div', { class: 'field-error' });
  const statusLine = h('div', { class: 'set-status', role: 'status' });
  const save = h('button', { class: 'btn primary small', type: 'button', text: 'Kaydet' });
  const reset = h('button', { class: 'btn ghost small', type: 'button', text: 'Varsayılana dön' });
  let row = null;

  function refresh() {
    const busy = settingsView.saving.has(key);
    const changed = settingsView.edits.has(key);
    // "Kaydet" only shows up once something was changed here.
    save.classList.toggle('hidden', !changed && !busy);
    save.disabled = blocked || busy || !changed || isInvalidEdit(settingsView.edits.get(key));
    reset.disabled = blocked || busy;
    const status = settingsView.status.get(key);
    statusLine.textContent = status?.text ?? '';
    statusLine.className = `set-status ${status?.kind ?? ''}`;
  }
  const setEdit = (next, redraw = true) => {
    if (SS.sameValue(next, current)) settingsView.edits.delete(key);
    else settingsView.edits.set(key, next);
    settingsView.status.delete(key);
    if (redraw) row.replaceWith(fieldRow(module, field));
    else refresh();
  };

  let control;
  const notes = [];
  if (field.yalnizDiscord) {
    const lines = Array.isArray(current) ? current : [];
    control = h(
      'div',
      { class: 'readonly-list' },
      lines.length
        ? lines.map((line) => h('div', { class: 'small', text: line }))
        : h('div', { class: 'muted small', text: 'Henüz yok.' }),
    );
    notes.push(h('div', { class: 'hint', text: `Bu ayarı Discord'da ${field.yalnizDiscord} ile yapın.` }));
  } else if (field.tur === 'bayrak') {
    const input = h('input', { type: 'checkbox', id, disabled: blocked });
    input.checked = value === true;
    input.addEventListener('change', () => setEdit(input.checked));
    control = h('label', { class: 'switch' }, input, h('span'));
  } else if (field.tur === 'kanal') {
    const choices = SS.channelChoices(guild, field.kanalTurleri);
    control = pickerSelect(id, choices, value, blocked, (next) => setEdit(next));
    const warning = choices.find((c) => c.id === value)?.warning;
    if (warning) notes.push(h('div', { class: 'field-warn', text: `⚠ ${warning}` }));
  } else if (field.tur === 'rol') {
    const choices = SS.roleChoices(guild, { verilebilir: field.verilebilir });
    control = pickerSelect(id, choices, value, blocked, (next) => setEdit(next));
    const warning = settingsView.data?.gorunum?.uyarilar?.[key];
    if (warning && !settingsView.edits.has(key))
      notes.push(h('div', { class: 'field-warn', text: `⚠ Şu an verilmiyor: ${warning}` }));
  } else if (isList(field)) {
    control = listControl(id, field, guild, Array.isArray(value) ? value : [], blocked, (next) => setEdit(next));
  } else {
    const long = field.tur === 'metin' && field.enFazla > 120;
    const input = h(long ? 'textarea' : 'input', {
      class: 'input',
      id,
      type: long ? undefined : field.tur === 'sayi' ? 'number' : 'text',
      min: field.tur === 'sayi' ? field.enAz : undefined,
      max: field.tur === 'sayi' ? field.enFazla : undefined,
      maxlength: field.tur === 'metin' ? field.enFazla : undefined,
      rows: long ? 3 : undefined,
      spellcheck: 'false',
      autocomplete: 'off',
      disabled: blocked,
    });
    input.value = isInvalidEdit(value) ? value.metin : value === null || value === undefined ? '' : String(value);
    input.addEventListener('input', () => {
      const parsed = SS.parseInput(field, input.value);
      input.classList.toggle('invalid', !parsed.ok);
      error.textContent = parsed.ok ? '' : parsed.error;
      setEdit(parsed.ok ? parsed.value : { metin: input.value }, false);
    });
    control = input;
  }

  async function send(next) {
    settingsView.saving.add(key);
    settingsView.status.set(key, { kind: 'busy', text: 'Kaydediliyor...' });
    refresh();
    let result;
    try {
      result = await api.saveServerSetting({
        guildId: settingsView.guildId,
        modul: module.ad,
        alan: field.anahtar,
        deger: next,
      });
    } catch (e) {
      result = { ok: false, hata: `Kaydedilemedi: ${e.message}` };
    }
    settingsView.saving.delete(key);
    if (result.ok) {
      settingsView.edits.delete(key);
      settingsView.status.set(key, { kind: 'ok', text: 'Kaydedildi; bot ayarı uyguladı.' });
    } else {
      settingsView.status.set(key, { kind: 'bad', text: result.hata ?? 'Kaydedilemedi.' });
    }
    await loadServerSettings(settingsView.guildId);
  }
  save.addEventListener('click', () => send(settingsView.edits.get(key)));
  reset.addEventListener('click', () => send(isList(field) ? [] : null));

  const editable = !field.yalnizDiscord;
  const isSet = settingsView.data?.gorunum?.ayarli?.includes(key);
  row = h(
    'div',
    { class: 'set-row', dataset: { key } },
    h(
      'label',
      { class: 'set-label', for: editable ? id : undefined },
      h('div', { class: 'field-label', text: field.etiket }),
      h('div', { class: 'field-key', text: key }),
    ),
    h(
      'div',
      { class: 'field-control' },
      h('div', { class: 'field-input-row' }, control),
      field.aciklama && field.aciklama !== field.etiket
        ? h('div', { class: 'field-help', text: field.aciklama })
        : null,
      ...notes,
      error,
      editable ? h('div', { class: 'set-actions' }, save, isSet ? reset : null, statusLine) : null,
    ),
  );
  refresh();
  return row;
}

function moduleCard(module) {
  return h(
    'article',
    { class: 'card set-card', dataset: { modul: module.ad } },
    h('div', { class: 'set-card-title', text: `${module.emoji ? `${module.emoji} ` : ''}${module.baslik}` }),
    module.kapali ? h('div', { class: 'alert warn', text: module.kapali }) : null,
    ...module.alanlar.map((field) => fieldRow(module, field)),
  );
}

function renderServerSettings() {
  const box = $('#server-settings');
  if (!settingsView.guildId) {
    box.replaceChildren();
    return;
  }
  const data = settingsView.data;
  const head = h(
    'header',
    { class: 'settings-head' },
    h('h2', { text: 'Ayarlar' }),
    h('p', {
      class: 'muted small',
      text: "Discord'daki /ayar ile aynı ayarlar. Bot her değişikliği /ayar ile aynı kurallarla denetler.",
    }),
  );
  if (!data) {
    box.replaceChildren(head, h('div', { class: 'muted', text: 'Yükleniyor...' }));
    return;
  }
  if (!data.sema || !data.yapi) {
    box.replaceChildren(
      head,
      h('div', {
        class: 'alert info',
        text: "Bu sunucunun ayar bilgileri henüz yok. Bot açılıp Discord'a bağlanınca kanal ve rol listeleri gelir.",
      }),
    );
    return;
  }
  const notes = [];
  if (!settingsView.live)
    notes.push(
      h('div', { class: 'alert warn', id: 'settings-bot-off', text: 'Bot kapalı; ayarlar bot açıkken uygulanır.' }),
    );
  if (data.saltOkunur)
    notes.push(
      h('div', {
        class: 'alert warn',
        text: 'Ayarlar şu an değiştirilemiyor: data/ozellikler.json daha yeni bir bot sürümüne ait. Botu güncelleyin.',
      }),
    );
  box.replaceChildren(
    head,
    ...notes,
    ...SS.groupModules(data.sema).map((group) =>
      h(
        'section',
        { class: 'settings-cat' },
        h('h3', { text: group.kategori }),
        h('div', { class: 'settings-grid' }, ...group.moduller.map(moduleCard)),
      ),
    ),
  );
}

// ---- statistics ---------------------------------------------------------------------------------

function tile(label, value, sub) {
  return h(
    'div',
    { class: 'tile' },
    h('div', { class: 'tile-label', text: label }),
    h('div', { class: 'tile-value', text: value }),
    sub ? h('div', { class: 'tile-sub', text: sub }) : null,
  );
}

/** Small line chart (SVG, no library). `values` may contain nulls (gaps are skipped). */
function sparkline(values, unit) {
  const points = values.map((v, i) => [i, v]).filter(([, v]) => typeof v === 'number');
  if (points.length < 2)
    return h('div', { class: 'muted small chart-empty', text: 'Grafik için bot çalışırken birkaç örnek gerekiyor.' });
  const width = 300;
  const height = 80;
  const pad = 4;
  const max = Math.max(...points.map(([, v]) => v), 1);
  const min = Math.min(...points.map(([, v]) => v), 0);
  const span = max - min || 1;
  const last = values.length - 1 || 1;
  const xy = points.map(([i, v]) => [
    pad + (i / last) * (width - 2 * pad),
    height - pad - ((v - min) / span) * (height - 2 * pad),
  ]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  const area = document.createElementNS(SVG_NS, 'polygon');
  area.setAttribute('points', `${xy[0][0]},${height} ${line} ${xy.at(-1)[0]},${height}`);
  area.setAttribute('class', 'spark-area');
  const poly = document.createElementNS(SVG_NS, 'polyline');
  poly.setAttribute('points', line);
  poly.setAttribute('class', 'spark-line');
  svg.append(area, poly);
  const lastValue = points.at(-1)[1];
  return h(
    'div',
    {},
    svg,
    h(
      'div',
      { class: 'chart-legend muted small' },
      h('span', { text: `son: ${fmtNumber(lastValue)} ${unit}` }),
      h('span', { text: `en yüksek: ${fmtNumber(max)} ${unit}` }),
    ),
  );
}

function rankList(id, items, emptyText) {
  const list = $(id);
  if (!items.length) {
    list.replaceChildren(h('li', { class: 'muted', text: emptyText }));
    return;
  }
  list.replaceChildren(
    ...items.map((item) =>
      h(
        'li',
        {},
        item.uri
          ? h('button', {
              class: 'link rank-name',
              type: 'button',
              text: item.label,
              onclick: () => openLink(item.uri),
            })
          : h('span', { class: 'rank-name', text: item.label }),
        h('span', { class: 'rank-count', text: fmtNumber(item.count) }),
      ),
    ),
  );
}

function renderStats() {
  setStaleNote('#stats-stale');
  const s = botData.status;
  const tiles = $('#stat-tiles');
  if (!s) {
    tiles.replaceChildren();
  } else {
    const { total, session } = s.counters;
    tiles.replaceChildren(
      tile('Sunucu', fmtNumber(s.bot.guildCount)),
      tile('Toplam üye', fmtNumber(s.bot.memberCount)),
      tile('Şu an çalan', `${fmtNumber(s.playingCount)} sunucu`),
      tile('Çalınan şarkı', fmtNumber(total.songsPlayed), `bu oturumda ${fmtNumber(session.songsPlayed)}`),
      tile('Kullanılan komut', fmtNumber(total.commandsUsed), `bu oturumda ${fmtNumber(session.commandsUsed)}`),
      tile('Çalışma süresi', fmtUptime(s.bot.uptimeMs)),
      tile('Ping', s.bot.pingMs === null ? '—' : `${s.bot.pingMs} ms`),
      tile('Bot belleği', fmtMb(s.bot.memory.rss)),
      tile(
        'Lavalink',
        s.lavalink.connected ? fmtMb(s.lavalink.memoryUsed) : 'bağlı değil',
        s.lavalink.connected ? `CPU %${(s.lavalink.cpuLoad * 100).toFixed(1)}` : null,
      ),
    );
  }
  const history = botData.history ?? [];
  $('#chart-ping').replaceChildren(
    sparkline(
      history.map((x) => x.pingMs),
      'ms',
    ),
  );
  $('#chart-memory').replaceChildren(
    sparkline(
      history.map((x) => x.rssMb),
      'MB',
    ),
  );
  $('#chart-players').replaceChildren(
    sparkline(
      history.map((x) => x.activePlayers),
      '',
    ),
  );
  rankList(
    '#top-commands',
    (s?.counters.total.commands ?? []).slice(0, 10).map((c) => ({ label: `/${c.name}`, count: c.count })),
    'Henüz komut kullanılmadı.',
  );
  rankList(
    '#top-songs',
    (s?.counters.total.topSongs ?? []).map((t) => ({ label: t.title, uri: t.uri, count: t.count })),
    'Henüz şarkı çalınmadı.',
  );
}

function applyBotData(next) {
  botData = next ?? { status: null, stale: true, history: [] };
  if ($('#view-servers').classList.contains('active')) renderServers();
  if ($('#view-stats').classList.contains('active')) renderStats();
  if (status) renderStatus(status);
}

// ---- events from the main process --------------------------------------------------------

api.on('olay:durum', renderStatus);
api.on('olay:botDurumu', applyBotData);
// The bot wrote new values (a save here, or /ayar in Discord): redraw, keeping what is being typed.
api.on('olay:sunucuAyar', () => {
  if (settingsView.guildId) loadServerSettings(settingsView.guildId);
});
// The bot has taken a request and is applying it (the answer is late): say so on that setting's row.
api.on('olay:sunucuAyarDurum', ({ guildId, modul, alan, durum } = {}) => {
  if (durum !== 'uygulaniyor' || guildId !== settingsView.guildId) return;
  const key = `${modul}.${alan}`;
  if (!settingsView.saving.has(key)) return;
  const text = 'Bot ayarı uyguluyor...';
  settingsView.status.set(key, { kind: 'busy', text });
  const line = document.querySelector(`[data-key="${CSS.escape(key)}"] .set-status`);
  if (line) {
    line.textContent = text;
    line.className = 'set-status busy';
  }
});
api.on('olay:kayit', appendLogs);
api.on('olay:youtube', () => {
  if (!$('#yt-modal').classList.contains('hidden')) renderYoutubeModal();
});
api.on('olay:indirme', ({ received, total }) => {
  const bar = $('#tool-download-progress .progress-bar');
  if (total) bar.style.width = `${Math.min(100, (received / total) * 100).toFixed(1)}%`;
  $('#tool-download-result').replaceChildren(
    h('div', {
      class: 'muted small',
      text: `${(received / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`,
    }),
  );
});

(async () => {
  logState.entries = await api.logs();
  botData = await api.botStatus();
  renderStatus(await api.status());
})();
