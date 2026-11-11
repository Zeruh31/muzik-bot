'use strict';

// Pure helpers for the "Ayarlar" part of the Servers tab: which channels and roles a field may
// pick, why a role is disabled, reading a typed input back, grouping modules by category.
// Loaded by the window as a plain script (window.serverSettings) and by the tests through require().
(function (root) {
  const KIND_LABELS = { metin: 'metin', ses: 'ses', kategori: 'kategori', forum: 'forum' };
  const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

  /** [{ kategori, moduller }] in the schema's category order; empty categories are left out. */
  function groupModules(schema) {
    if (!schema) return [];
    const order = schema.kategoriler ?? [];
    const groups = order.map((kategori) => ({
      kategori,
      moduller: schema.moduller.filter((m) => m.kategori === kategori),
    }));
    return groups.filter((g) => g.moduller.length);
  }

  /** "#genel", "🔊 Sohbet" or "▸ Oyun" with its category in front. */
  function channelLabel(channel) {
    const prefix = { metin: '#', ses: '🔊 ', kategori: '▸ ', forum: '💬 ' }[channel.tur] ?? '';
    return channel.kategori && channel.tur !== 'kategori'
      ? `${channel.kategori} › ${prefix}${channel.ad}`
      : `${prefix}${channel.ad}`;
  }

  /** The warning for a channel the bot cannot use, or null. */
  function channelWarning(channel) {
    if (channel.tur === 'metin' && !channel.yazabilir) return 'Bot bu kanalı göremiyor ya da buraya yazamıyor.';
    if (channel.tur === 'ses' && !channel.baglanabilir) return 'Bot bu ses kanalına bağlanamıyor.';
    return null;
  }

  /** Channels of the field's types: [{ id, label, warning }]. */
  function channelChoices(guild, kinds) {
    return (guild?.kanallar ?? [])
      .filter((c) => kinds.includes(c.tur))
      .map((c) => ({ id: c.id, label: channelLabel(c), warning: channelWarning(c) }));
  }

  /** Why a role cannot be picked for a field, or null. */
  function roleBlock(role, { verilebilir = false } = {}) {
    if (role.yonetilen) return 'bir bota ya da sunucu takviyesine ait';
    if (!verilebilir) return null;
    if (role.tehlikeli) return 'yönetim izni var (dağıtılamaz)';
    if (!role.verilebilir) return role.neden ?? 'bot bu rolü veremiyor';
    return null;
  }

  /** Roles, highest first: [{ id, label, disabled, reason }]. */
  function roleChoices(guild, options) {
    return (guild?.roller ?? []).map((r) => {
      const reason = roleBlock(r, options);
      return { id: r.id, label: `@${r.ad}`, color: r.renk, disabled: Boolean(reason), reason };
    });
  }

  /** A name for a stored id (for lists and read-only values). */
  function nameOf(guild, id) {
    const channel = guild?.kanallar?.find((c) => c.id === id);
    if (channel) return channelLabel(channel);
    const role = guild?.roller?.find((r) => r.id === id);
    if (role) return `@${role.ad}`;
    return 'silinmiş öğe';
  }

  /**
   * The typed value of an input, checked like the bot does: { ok: true, value } or { ok: false, error }.
   * `raw` is the input's string (a checkbox gives a boolean, a list an array).
   */
  function parseInput(field, raw) {
    switch (field.tur) {
      case 'bayrak':
        return { ok: true, value: raw === true };
      case 'kanal':
      case 'rol':
        return { ok: true, value: raw ? String(raw) : null };
      case 'kanal-listesi':
      case 'rol-listesi': {
        const list = Array.isArray(raw) ? [...new Set(raw)] : [];
        if (list.length > field.enFazla) return { ok: false, error: `En fazla ${field.enFazla} öğe seçilebilir.` };
        return { ok: true, value: list };
      }
      case 'sayi': {
        const text = String(raw ?? '').trim();
        if (!/^-?\d+$/.test(text)) return { ok: false, error: 'Bir tam sayı yazın.' };
        const value = Number(text);
        if (value < field.enAz || value > field.enFazla)
          return { ok: false, error: `${field.enAz} ile ${field.enFazla} arasında olmalı.` };
        return { ok: true, value };
      }
      case 'metin': {
        const text = String(raw ?? '').trim();
        if (text.length < field.enAz || text.length > field.enFazla)
          return { ok: false, error: `${field.enAz}-${field.enFazla} karakter olmalı (şu an ${text.length}).` };
        if (CONTROL_CHARS.test(text)) return { ok: false, error: 'Görünmeyen denetim karakterleri olamaz.' };
        return { ok: true, value: text };
      }
      default:
        return { ok: false, error: 'Bu ayar uygulamadan değiştirilemez.' };
    }
  }

  /** Whether two values are the same (lists by content). */
  function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
      const x = Array.isArray(a) ? a : [];
      const y = Array.isArray(b) ? b : [];
      return x.length === y.length && x.every((v, i) => v === y[i]);
    }
    return (a ?? null) === (b ?? null);
  }

  /** "metin, ses" for the hint under a channel picker. */
  const kindsText = (kinds) => kinds.map((k) => KIND_LABELS[k] ?? k).join(', ');

  const api = {
    groupModules,
    channelLabel,
    channelWarning,
    channelChoices,
    roleBlock,
    roleChoices,
    nameOf,
    parseInput,
    sameValue,
    kindsText,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.serverSettings = api;
})(typeof window === 'undefined' ? globalThis : window);
