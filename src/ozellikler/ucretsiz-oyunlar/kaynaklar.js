// Ücretsiz oyunların kaynakları ve yanıtlarının ayrıştırılması. İki kaynak var, ikisi de anahtar istemez:
//   Epic      store-site-backend-static.../freeGamesPromotions  (Epic'in kendi mağaza sayfasının kullandığı,
//             belgesiz uç nokta; bozulursa Epic için GamerPower'a geçilir)
//   GamerPower www.gamerpower.com/api/giveaways?platform=steam|gog|epic-games-store&type=game  (açık API)
// Yalnız kalıcı olarak alınabilen, şu an ücretsiz oyunlar alınır: DLC ve oyun içi eşyalar, demo, beta,
// "free weekend" denemeleri, ücretsiz oynanan (zaten bedava) oyunlar ve başka sitelerin anahtar dağıtımları
// ("Key Giveaway") alınmaz (GamerPower'da type alanı ve başlık/açıklama desenleriyle). Bağlantılar yalnız https.
// İstekler genel bir User-Agent ile gider (kişisel bilgi yok), 10 sn zaman aşımı ve bir yeniden deneme var.

export const EPIC_URL =
  'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
export const gamerPowerUrl = (platform) =>
  `https://www.gamerpower.com/api/giveaways?platform=${encodeURIComponent(platform)}&type=game`;
export const USER_AGENT = 'muzik-bot/2 (open-source Discord bot; free games check)';
export const PLATFORMLAR = Object.freeze(['epic', 'steam', 'gog']);
const GAMERPOWER_PLATFORM = { epic: 'epic-games-store', steam: 'steam', gog: 'gog' };
const EPIC_STORE = 'https://store.epicgames.com';
const EPIC_IMAGE_TYPES = ['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail', 'OfferImageTall'];
const TITLE_MAX = 200;
const TEXT_MAX = 400;

const isHttps = (value) => typeof value === 'string' && /^https:\/\/[^\s<>"]+$/i.test(value) && value.length <= 512;
const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A temporary problem (worth trying again): network error, timeout, 429 or 5xx. */
class KaynakHatasi extends Error {
  constructor(message, { retry = true } = {}) {
    super(message);
    this.retry = retry;
  }
}

/**
 * GETs a JSON document. Tries once more after `retryDelayMs` on a temporary problem; throws when it
 * still fails (the caller then skips that source until the next check).
 */
export async function getJson(
  url,
  { fetch = globalThis.fetch, timeoutMs = 10_000, retries = 1, retryDelayMs = 3000, sleep = delay } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      let response;
      try {
        response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new KaynakHatasi(error?.message ?? String(error));
      }
      if (response.status === 429 || response.status >= 500) throw new KaynakHatasi(`HTTP ${response.status}`);
      if (!response.ok) throw new KaynakHatasi(`HTTP ${response.status}`, { retry: false });
      try {
        return await response.json();
      } catch {
        throw new KaynakHatasi('geçersiz JSON', { retry: false });
      }
    } catch (error) {
      if (!error.retry || attempt >= retries) throw error;
      await sleep(retryDelayMs);
    }
  }
}

/**
 * The same game from two sources gives the same key: "Flotsam (Epic Games) Giveaway" and "Flotsam" are
 * both "epic:flotsam". The key is what data/ucretsiz-oyunlar.json remembers as announced.
 */
export function oyunAnahtari(platform, baslik) {
  const slug = String(baslik ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(key|giveaway)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${platform}:${slug}`;
}

function offer({ platform, baslik, aciklama, gorsel, bitis, url, deger, kaynak }) {
  const title = text(baslik, TITLE_MAX);
  if (!title || !isHttps(url)) return null;
  return {
    anahtar: oyunAnahtari(platform, title),
    platform,
    baslik: title,
    aciklama: aciklama && aciklama !== title ? text(aciklama, TEXT_MAX) : null,
    gorsel: isHttps(gorsel) ? gorsel : null,
    bitis: Number.isFinite(bitis) ? bitis : null,
    url,
    deger: text(deger, 20),
    kaynak,
  };
}

function epicSlug(element) {
  const fromMappings = (list) => (Array.isArray(list) ? list : []).find((m) => m?.pageType === 'productHome')?.pageSlug;
  const slug =
    fromMappings(element.catalogNs?.mappings) ??
    fromMappings(element.offerMappings) ??
    (typeof element.productSlug === 'string' ? element.productSlug.replace(/\/home$/, '') : null);
  return typeof slug === 'string' && /^[\w-]{1,120}$/.test(slug) ? slug : null;
}

/** The games Epic gives away right now (free to keep, normally paid), from a freeGamesPromotions reply. */
export function epicAyristir(json, now = Date.now()) {
  const elements = json?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) throw new Error('Epic yanıtının biçimi değişmiş');
  const offers = [];
  for (const element of elements) {
    if (!element || element.offerType === 'ADD_ON') continue;
    const price = element.price?.totalPrice;
    if (price?.discountPrice !== 0 || !(price?.originalPrice > 0)) continue;
    const promo = (element.promotions?.promotionalOffers ?? [])
      .flatMap((p) => p?.promotionalOffers ?? [])
      .find(
        (o) =>
          Date.parse(o?.startDate) <= now &&
          now < Date.parse(o?.endDate) &&
          o?.discountSetting?.discountPercentage === 0,
      );
    if (!promo) continue;
    const slug = epicSlug(element);
    const image = EPIC_IMAGE_TYPES.map((type) => element.keyImages?.find?.((k) => k?.type === type)?.url).find(isHttps);
    const made = offer({
      platform: 'epic',
      baslik: element.title,
      aciklama: element.description,
      gorsel: image,
      bitis: Date.parse(promo.endDate),
      url: slug ? `${EPIC_STORE}/p/${slug}` : `${EPIC_STORE}/free-games`,
      deger: price.fmtPrice?.originalPrice,
      kaynak: 'Epic Games Store',
    });
    if (made) offers.push(made);
  }
  return offers;
}

/** "2026-11-12 23:59:00" (GamerPower, read as UTC) -> ms; "N/A" -> null. */
function gamerPowerDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Not a game you keep: DLC and in-game items, demos, betas and playtests, free weekends and free-to-play
// games (free anyway). GamerPower marks loot and betas in `type`; the rest only shows in the text.
const NOT_KEPT_TITLE =
  /\b(keys?|dlc|add-?ons?|expansion|season pass|soundtrack|skins?|demo|beta|playtest|free[- ]?weekend|free[- ]to[- ]play|f2p|early access)\b/i;
// "pack" alone is a real game too ("Pack It Up", "Cube Pack Tycoon"): only DLC-style packs are dropped.
const NOT_KEPT_PACK =
  /\b(dlc|skin|starter|bonus|content|cosmetic|character|weapon|item|loot|booster|bundle|expansion|upgrade|supporter|founder'?s?|deluxe|premium|welcome|cheat|season)[ -]pack\b/i;
const NOT_KEPT_TEXT =
  /\b(free[- ]?weekend|play (it )?for free (this|until|during)|free[- ]to[- ]play|f2p|limited[- ]time trial|in-game (items?|content)|dlc)\b/i;

/**
 * Whether a GamerPower giveaway is a whole game that stays yours: type "Game" (not "DLC"/"Loot"/"Beta"),
 * active, and nothing in the title or text says weekend, trial, DLC, demo, free-to-play or a third-party
 * key giveaway (limited keys, usually an account on another site).
 */
export function kaliciOyunMu(item) {
  if (item?.type !== 'Game' || item.status !== 'Active') return false;
  if (NOT_KEPT_TITLE.test(item.title ?? '') || NOT_KEPT_PACK.test(item.title ?? '')) return false;
  return !NOT_KEPT_TEXT.test(`${item.description ?? ''} ${item.instructions ?? ''}`);
}

/** Active, free-to-keep game giveaways of one platform from a GamerPower reply. */
export function gamerPowerAyristir(json, platform, now = Date.now()) {
  // No giveaways: GamerPower answers 201 with { status: 0, status_message: "No active giveaways..." }.
  if (!Array.isArray(json)) {
    if (json && typeof json === 'object' && json.status === 0) return [];
    throw new Error('GamerPower yanıtının biçimi değişmiş');
  }
  const offers = [];
  for (const item of json) {
    if (!kaliciOyunMu(item)) continue;
    const bitis = gamerPowerDate(item.end_date);
    if (bitis !== null && bitis <= now) continue;
    const baslik = String(item.title ?? '')
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\bgiveaway\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const made = offer({
      platform,
      baslik,
      aciklama: item.description,
      gorsel: item.image ?? item.thumbnail,
      bitis,
      url: item.open_giveaway_url ?? item.open_giveaway ?? item.gamerpower_url,
      deger: item.worth && item.worth !== 'N/A' ? item.worth : null,
      kaynak: 'GamerPower',
    });
    if (made) offers.push(made);
  }
  return offers;
}

/**
 * Fetches the free games of the given platforms. A source that fails gives { ok: false } and does not
 * stop the others. Requests start a little apart (GamerPower gets at most three every check).
 * @returns {Promise<Record<string, { ok: boolean, offers: object[], hata?: string }>>}
 */
export async function oyunlariGetir(platforms, { now = Date.now(), staggerMs = 750, sleep = delay, ...http } = {}) {
  const viaGamerPower = async (platform) =>
    gamerPowerAyristir(await getJson(gamerPowerUrl(GAMERPOWER_PLATFORM[platform]), { sleep, ...http }), platform, now);
  const tasks = {
    epic: async () => {
      try {
        return epicAyristir(await getJson(EPIC_URL, { sleep, ...http }), now);
      } catch {
        return viaGamerPower('epic'); // Epic's undocumented endpoint changed or is down
      }
    },
    steam: () => viaGamerPower('steam'),
    gog: () => viaGamerPower('gog'),
  };
  const wanted = PLATFORMLAR.filter((p) => platforms.includes(p));
  const entries = await Promise.all(
    wanted.map(async (platform, i) => {
      if (i > 0 && staggerMs > 0) await sleep(staggerMs * i);
      try {
        return [platform, { ok: true, offers: await tasks[platform]() }];
      } catch (error) {
        return [platform, { ok: false, offers: [], hata: String(error?.message ?? error).slice(0, 200) }];
      }
    }),
  );
  return Object.fromEntries(entries);
}
