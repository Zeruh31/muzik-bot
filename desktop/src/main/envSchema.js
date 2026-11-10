'use strict';

// The settings form: which .env keys exist, how they are grouped, explained and checked.
// Texts follow .env.example and README.md. `restart` says what must restart after a change.

const DEV_PORTAL = 'https://discord.com/developers/applications';

const GROUPS = [
  {
    id: 'discord',
    title: 'Discord',
    description: "Botun Discord hesabı. Developer Portal'dan alınır (README, 3. adım).",
    fields: [
      {
        key: 'DISCORD_TOKEN',
        label: 'Bot token',
        type: 'secret',
        required: true,
        restart: 'bot',
        help: 'Developer Portal > uygulamanız > Bot > "Reset Token" ile alınan token. Kimseyle paylaşmayın; sızarsa yeniden "Reset Token" yapın.',
        link: DEV_PORTAL,
        linkText: 'Developer Portal',
      },
      {
        key: 'DISCORD_CLIENT_ID',
        label: 'Uygulama kimliği (Application ID)',
        type: 'text',
        required: true,
        restart: 'bot',
        pattern: 'snowflake',
        help: 'Developer Portal > uygulamanız > General Information > "Application ID".',
        link: DEV_PORTAL,
        linkText: 'Developer Portal',
      },
      {
        key: 'DISCORD_GUILD_ID',
        label: 'Sunucu kimliği (isteğe bağlı)',
        type: 'text',
        restart: 'bot',
        pattern: 'snowflake',
        help: 'Doluysa komutlar yalnız o sunucuya ve anında kaydedilir; boşsa tüm sunuculara (birkaç dakika sürebilir). Discord > Ayarlar > Gelişmiş > Geliştirici Modu açıkken sunucuya sağ tıklayıp "Sunucu Kimliğini Kopyala".',
      },
      {
        key: 'BOT_OWNER_IDS',
        label: 'Bot sahipleri (isteğe bağlı)',
        type: 'text',
        restart: 'bot',
        pattern: 'snowflakeList',
        placeholder: '123456789012345678,234567890123456789',
        help: '/servers gibi sahip komutlarını kimlerin kullanabileceği. Boşsa sahip Developer Portal\'dan kendiliğinden bulunur (takımdaysa takım sahibi ve Admin üyeleri). Doldurursanız YALNIZCA buradaki kişiler sahip sayılır; birden çok kimliği virgülle ayırın. Kimlik için Geliştirici Modu açıkken kullanıcıya sağ tıklayıp "Kullanıcı Kimliğini Kopyala".',
      },
    ],
  },
  {
    id: 'lavalink',
    title: 'Lavalink',
    description: 'Sesi işleyen Lavalink sunucusu. Bot ve Lavalink aynı şifreyi kullanır.',
    fields: [
      {
        key: 'LAVALINK_PASSWORD',
        label: 'Lavalink şifresi',
        type: 'secret',
        required: true,
        restart: 'both',
        generate: true,
        help: 'Kendi belirlediğiniz bir şifre: uzun ve tahmin edilmesi zor bir kelime dizisi. Hem bot hem Lavalink bunu kullanır.',
      },
      {
        key: 'LAVALINK_HOST',
        label: 'Lavalink adresi',
        type: 'text',
        restart: 'bot',
        placeholder: '127.0.0.1',
        help: "Normalde dokunmayın. Lavalink her zaman yalnızca 127.0.0.1'i dinler; bu yalnızca botun bağlanacağı adrestir.",
      },
      {
        key: 'LAVALINK_PORT',
        label: 'Lavalink portu',
        type: 'number',
        min: 1,
        max: 65535,
        restart: 'both',
        placeholder: '2333',
        help: "Hem Lavalink'in dinlediği hem botun bağlandığı port. 2333 başka bir programca kullanılıyorsa değiştirin.",
      },
      {
        key: 'LAVALINK_JAVA_MEMORY',
        label: 'Lavalink belleği',
        type: 'text',
        pattern: 'heap',
        restart: 'lavalink',
        placeholder: '512M',
        help: "Lavalink'in kullanabileceği en fazla bellek (ör. 512M, 1G).",
      },
    ],
  },
  {
    id: 'youtube',
    title: 'YouTube',
    description: 'YouTube botları engellediği için Lavalink bir Google hesabıyla giriş yapar (README, 7. adım).',
    fields: [
      {
        key: 'YOUTUBE_OAUTH_REFRESH_TOKEN',
        label: 'YouTube refresh token',
        type: 'secret',
        restart: 'lavalink',
        help: 'İlk çalıştırmada boş bırakın: Lavalink açılınca uygulama giriş kodunu gösterir, YAN bir Google hesabıyla giriş yapınca token buraya kendiliğinden kaydedilir. Ana Google hesabınızı KULLANMAYIN.',
        link: 'https://www.google.com/device',
        linkText: 'google.com/device',
      },
    ],
  },
  {
    id: 'spotify',
    title: 'Spotify',
    description:
      "İsteğe bağlı. Spotify bağlantıları YouTube'daki karşılıklarıyla çalınır. Uygulama sahibinin Spotify Premium üyesi olması gerekir.",
    fields: [
      {
        key: 'SPOTIFY_CLIENT_ID',
        label: 'Spotify Client ID',
        type: 'text',
        restart: 'lavalink',
        help: 'developer.spotify.com/dashboard > Create app (Redirect URI: http://127.0.0.1:8888/callback, Web API işaretli) > Settings > Client ID.',
        link: 'https://developer.spotify.com/dashboard',
        linkText: 'Spotify Dashboard',
      },
      {
        key: 'SPOTIFY_CLIENT_SECRET',
        label: 'Spotify Client secret',
        type: 'secret',
        restart: 'lavalink',
        help: 'Aynı sayfadaki "Client secret". Boş bırakılırsa Spotify bağlantıları çalışmaz, YouTube çalışmaya devam eder.',
        link: 'https://developer.spotify.com/dashboard',
        linkText: 'Spotify Dashboard',
      },
    ],
  },
  {
    id: 'music',
    title: 'Müzik davranışı',
    description: 'Varsayılanlar çoğu kişi için uygundur.',
    fields: [
      {
        key: 'DEFAULT_VOLUME',
        label: 'Başlangıç ses seviyesi',
        type: 'number',
        min: 1,
        max: 150,
        restart: 'bot',
        placeholder: '80',
        help: 'Yeni oynatıcıların başlangıç ses seviyesi (1-150, 100 = normal).',
      },
      {
        key: 'TWENTY_FOUR_SEVEN',
        label: '7/24 modu',
        type: 'bool',
        default: 'false',
        restart: 'bot',
        help: 'Açıksa bot ses kanalından kendiliğinden hiç ayrılmaz.',
      },
      {
        key: 'LEAVE_WHEN_EMPTY_SECONDS',
        label: 'Kanal boşalınca ayrılma (sn)',
        type: 'number',
        min: 0,
        max: 86400,
        restart: 'bot',
        placeholder: '60',
        help: 'Ses kanalında kimse kalmayınca kaç saniye sonra ayrılsın.',
      },
      {
        key: 'LEAVE_AFTER_QUEUE_END_SECONDS',
        label: 'Kuyruk bitince ayrılma (sn)',
        type: 'number',
        min: 0,
        max: 86400,
        restart: 'bot',
        placeholder: '120',
        help: 'Kuyruk bitince kaç saniye sonra ayrılsın.',
      },
      {
        key: 'SEARCH_SOURCE',
        label: 'Arama kaynağı',
        type: 'select',
        options: [
          { value: 'ytmsearch', label: 'YouTube Music (ytmsearch)' },
          { value: 'ytsearch', label: 'YouTube (ytsearch)' },
          { value: 'scsearch', label: 'SoundCloud (scsearch)' },
        ],
        restart: 'bot',
        help: 'Şarkı adıyla arama nerede yapılsın.',
      },
      {
        key: 'PLAY_SHOW_CHOICES',
        label: '/play sonuç listesi',
        type: 'bool',
        default: 'true',
        restart: 'bot',
        help: 'Açıksa /play şarkı adıyla kullanılınca ilk 5 sonuç listelenir, seçtiğiniz çalar. Kapalıysa ilk sonuç doğrudan çalar. Bağlantılar ve çalma listeleri her zaman doğrudan çalar.',
      },
      {
        key: 'MAX_QUEUE_SIZE',
        label: 'En fazla kuyruk uzunluğu',
        type: 'number',
        min: 1,
        max: 10000,
        restart: 'bot',
        placeholder: '1000',
        help: 'Kuyrukta en fazla kaç şarkı olabilir.',
      },
      {
        key: 'EMBED_COLOR',
        label: 'Mesaj rengi',
        type: 'text',
        pattern: 'color',
        restart: 'bot',
        placeholder: '5865F2',
        help: 'Mesaj kutularının rengi: 6 haneli renk kodu, başına # koymayın.',
      },
      {
        key: 'LOG_LEVEL',
        label: 'Kayıt ayrıntısı',
        type: 'select',
        options: [
          { value: 'debug', label: 'debug (çok ayrıntılı)' },
          { value: 'info', label: 'info (önerilen)' },
          { value: 'warn', label: 'warn' },
          { value: 'error', label: 'error' },
        ],
        restart: 'bot',
        help: 'Botun kayıtlara ne kadar ayrıntı yazacağı.',
      },
    ],
  },
  {
    id: 'appearance',
    title: 'Görünüm',
    description: "/help komutunun altındaki bağlantılar. Boş bırakılan bağlantı /help'te hiç gösterilmez.",
    fields: [
      {
        key: 'BRAND_SUPPORT_URL',
        label: 'Destek sunucusu bağlantısı',
        type: 'text',
        pattern: 'httpsUrl',
        restart: 'bot',
        placeholder: 'https://discord.com/invite/abc123',
        help: 'Kendi Discord sunucunuzun davet bağlantısı. /help altında "Discord" olarak görünür. Discord > sunucu adı > Davet Et > "Süresi dolmayan" bağlantı.',
      },
      {
        key: 'BRAND_AUTHOR_NAME',
        label: 'Yapımcı adı',
        type: 'text',
        restart: 'bot',
        help: '/help altında "By <ad>" olarak görünür (en fazla 64 karakter).',
      },
      {
        key: 'BRAND_AUTHOR_URL',
        label: 'Yapımcı bağlantısı',
        type: 'text',
        pattern: 'httpsUrl',
        restart: 'bot',
        placeholder: 'https://example.com',
        help: 'Web siteniz ya da sosyal medya profiliniz; yapımcı adına bağlantı olur. Ad boşsa gösterilmez.',
      },
    ],
  },
  {
    id: 'panel',
    title: 'Web paneli',
    description: 'Bot çalışırken müziği tarayıcıdan yönetmek için (README, 10. adım).',
    fields: [
      {
        key: 'PANEL_ENABLED',
        label: 'Web paneli açık',
        type: 'bool',
        default: 'false',
        restart: 'bot',
        help: 'Açıksa bot başlayınca tarayıcıdan yönetilebilen panel de açılır.',
      },
      {
        key: 'DISCORD_CLIENT_SECRET',
        label: 'Discord Client Secret',
        type: 'secret',
        restart: 'bot',
        help: 'Developer Portal > uygulamanız > OAuth2 > "Reset Secret". Aynı sayfadaki Redirects bölümüne panel adresi + /auth/callback eklenmeli. Boşsa panel açılmaz.',
        link: DEV_PORTAL,
        linkText: 'Developer Portal',
      },
      {
        key: 'PANEL_SESSION_SECRET',
        label: 'Oturum anahtarı',
        type: 'secret',
        restart: 'bot',
        generate: true,
        help: 'Oturum çerezlerini imzalayan en az 32 karakterlik rastgele metin. "Üret" düğmesi sizin için oluşturur. Boşsa her açılışta herkes çıkış yapmış olur.',
      },
      {
        key: 'PANEL_HOST',
        label: 'Dinlenen adres',
        type: 'text',
        restart: 'bot',
        placeholder: '127.0.0.1',
        help: '127.0.0.1 = yalnızca bu bilgisayar (en güvenlisi).',
      },
      {
        key: 'PANEL_PORT',
        label: 'Panel portu',
        type: 'number',
        min: 1,
        max: 65535,
        restart: 'bot',
        placeholder: '3000',
        help: "Değiştirirseniz panel adresini ve Developer Portal'daki Redirect adresini de güncelleyin.",
      },
      {
        key: 'PANEL_PUBLIC_URL',
        label: 'Panel adresi',
        type: 'text',
        pattern: 'url',
        restart: 'bot',
        placeholder: 'http://127.0.0.1:3000',
        help: "Tarayıcıda açtığınız adres. Developer Portal'daki Redirect adresi bunun sonuna /auth/callback eklenmiş hali olmalı.",
      },
      {
        key: 'PANEL_TRUST_PROXY',
        label: 'Ters proxy arkasında',
        type: 'bool',
        default: 'false',
        restart: 'bot',
        help: 'Panel Caddy/nginx gibi bir ters proxy arkasındaysa açın. Aksi halde kapalı kalsın.',
      },
    ],
  },
];

const FIELDS = new Map(
  GROUPS.flatMap((group) => group.fields.map((field) => [field.key, { ...field, group: group.id }])),
);

const SECRET_KEYS = [...FIELDS.values()].filter((f) => f.type === 'secret').map((f) => f.key);

const TRUE_WORDS = ['1', 'true', 'evet', 'yes', 'on', 'acik', 'açık'];
const FALSE_WORDS = ['0', 'false', 'hayir', 'hayır', 'no', 'off', 'kapali', 'kapalı'];

/** Checks one value; returns a Turkish error message or null. Empty optional values are fine. */
function validateField(key, rawValue) {
  const field = FIELDS.get(key);
  const value = String(rawValue ?? '').trim();
  if (/[\r\n]/.test(String(rawValue ?? ''))) return 'Değer tek satır olmalı.';
  if (!field) return null;
  if (value === '') return field.required ? 'Bu alan zorunlu.' : null;
  if (field.type === 'number') {
    const n = Number(value);
    if (!/^-?\d+$/.test(value) || n < field.min || n > field.max)
      return `${field.min} ile ${field.max} arasında bir tam sayı olmalı.`;
  }
  if (field.type === 'bool' && ![...TRUE_WORDS, ...FALSE_WORDS].includes(value.toLowerCase()))
    return '"true" ya da "false" olmalı.';
  if (field.type === 'select' && !field.options.some((o) => o.value === value)) {
    return `Şunlardan biri olmalı: ${field.options.map((o) => o.value).join(', ')}.`;
  }
  if (field.pattern === 'snowflake' && !/^\d{17,20}$/.test(value)) return 'Yalnızca rakamlardan oluşmalı (17-20 hane).';
  if (field.pattern === 'snowflakeList' && !/^\d{17,20}(\s*,\s*\d{17,20})*$/.test(value)) {
    return 'Virgülle ayrılmış Discord kullanıcı kimlikleri olmalı (her biri 17-20 rakam).';
  }
  if (field.pattern === 'color' && !/^#?[0-9a-fA-F]{6}$/.test(value))
    return '5865F2 gibi 6 haneli bir renk kodu olmalı.';
  if (field.pattern === 'heap' && !/^\d+[kKmMgG]?$/.test(value)) return '512M ya da 1G gibi olmalı.';
  if (field.pattern === 'url') {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || (url.pathname !== '/' && url.pathname !== '')) {
        return 'http(s)://adres:port biçiminde olmalı, sonunda yol olmamalı.';
      }
    } catch {
      return 'Geçerli bir adres değil. Örnek: http://127.0.0.1:3000';
    }
  }
  if (field.pattern === 'httpsUrl') {
    // Same rule as src/config.js (readHttpsUrl): only https links.
    let url = null;
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:')
      return 'https:// ile başlayan geçerli bir adres olmalı ya da boş bırakılmalı.';
  }
  if (field.key === 'BRAND_AUTHOR_NAME' && value.length > 64) return 'En fazla 64 karakter olabilir.';
  return null;
}

/** Checks a set of values; returns { KEY: message } for the bad ones. */
function validateValues(values) {
  const errors = {};
  for (const [key, value] of Object.entries(values)) {
    const message = validateField(key, value);
    if (message) errors[key] = message;
  }
  return errors;
}

/** Which processes need a restart after these keys changed: { lavalink, bot }. */
function restartNeeds(changedKeys) {
  const needs = { lavalink: false, bot: false };
  for (const key of changedKeys) {
    const scope = FIELDS.get(key)?.restart ?? 'bot';
    if (scope === 'lavalink' || scope === 'both') needs.lavalink = true;
    if (scope === 'bot' || scope === 'both') needs.bot = true;
  }
  return needs;
}

function isTrue(value) {
  return TRUE_WORDS.includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

module.exports = { GROUPS, FIELDS, SECRET_KEYS, validateField, validateValues, restartNeeds, isTrue };
