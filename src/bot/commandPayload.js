// Komut tanımlarını Discord'un kurallarına göre denetler ("npm run deploy-commands -- --check").
// Normalde dokunmana gerek yok.
//
// Builds the JSON sent to Discord and checks it against Discord's documented limits, so
// mistakes are caught locally (without a token) instead of as a 400 from the API.

const NAME_PATTERN = /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;
const MAX_GLOBAL_COMMANDS = 100;
const MAX_OPTIONS = 25;
const MAX_CHOICES = 25;
/** Names, descriptions and choice values of a slash command with all its options (Discord's documented limit). */
export const MAX_TOTAL_CHARS = 8000;
const MAX_CONTEXT_COMMANDS = 15;
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

function checkName(name, where, problems) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    problems.push(`${where}: geçersiz ad "${name}"`);
  } else if (name !== name.toLowerCase()) {
    problems.push(`${where}: ad küçük harf olmalı ("${name}")`);
  }
}

function checkDescription(description, where, problems) {
  if (typeof description !== 'string' || description.length < 1 || description.length > 100) {
    problems.push(`${where}: açıklama 1-100 karakter olmalı (${description?.length ?? 0})`);
  }
}

/**
 * The length Discord counts for one text field: with localizations, only the longest of the default text and
 * its translations (Discord's docs: "only the longest localization for each field ... is counted").
 */
function fieldLength(text, localizations) {
  const lengths = [String(text ?? '').length, ...Object.values(localizations ?? {}).map((t) => String(t ?? '').length)];
  return Math.max(...lengths);
}

/** The characters Discord counts towards MAX_TOTAL_CHARS for a command (or one of its options). */
export function countChars(option) {
  let total =
    fieldLength(option.name, option.name_localizations) +
    fieldLength(option.description, option.description_localizations);
  for (const choice of option.choices ?? [])
    total += fieldLength(choice.name, choice.name_localizations) + String(choice.value).length;
  for (const sub of option.options ?? []) total += countChars(sub);
  return total;
}

function checkOptions(options, where, problems) {
  if (!options) return;
  if (options.length > MAX_OPTIONS) problems.push(`${where}: en fazla ${MAX_OPTIONS} seçenek olabilir`);
  const names = new Set();
  let seenOptional = false;
  for (const option of options) {
    const at = `${where} > ${option.name}`;
    checkName(option.name, at, problems);
    checkDescription(option.description, at, problems);
    if (names.has(option.name)) problems.push(`${at}: aynı adlı seçenek iki kez var`);
    names.add(option.name);
    if (option.required && seenOptional) problems.push(`${at}: zorunlu seçenekler isteğe bağlılardan önce gelmeli`);
    if (!option.required) seenOptional = true;
    if ((option.choices?.length ?? 0) > MAX_CHOICES) problems.push(`${at}: en fazla ${MAX_CHOICES} seçim olabilir`);
    checkOptions(option.options, at, problems);
  }
}

/** Subcommand groups may only hold subcommands, and subcommands no further subcommands (2 levels). */
function checkDepth(options, where, problems, level = 0) {
  for (const option of options ?? []) {
    const nested = option.type === SUBCOMMAND || option.type === SUBCOMMAND_GROUP;
    if (!nested) continue;
    const at = `${where} ${option.name}`;
    if (option.type === SUBCOMMAND_GROUP && level > 0) problems.push(`${at}: alt komut grubu iç içe olamaz`);
    if (option.type === SUBCOMMAND_GROUP && (option.options ?? []).some((o) => o.type !== SUBCOMMAND)) {
      problems.push(`${at}: alt komut grubunda yalnız alt komut olabilir`);
    }
    if (
      option.type === SUBCOMMAND &&
      (option.options ?? []).some((o) => o.type === SUBCOMMAND || o.type === SUBCOMMAND_GROUP)
    ) {
      problems.push(`${at}: alt komutun içinde alt komut olamaz`);
    }
    checkDepth(option.options, where, problems, level + 1);
  }
}

/**
 * Converts loaded command modules to API JSON and validates them.
 * @returns {{ body: object[], problems: string[] }}
 */
export function buildCommandPayload(commands) {
  const problems = [];
  const body = [];
  for (const { data, file } of commands.values()) {
    let json;
    try {
      json = data.toJSON();
    } catch (error) {
      problems.push(`${file}: tanım derlenemedi: ${error.message}`);
      continue;
    }
    const type = json.type ?? 1;
    const where = type === 1 ? `/${json.name}` : `"${json.name}" (sağ tık)`;
    if (type !== 1) {
      // User and message context menu commands: a display name (spaces and capitals allowed), no description.
      if (
        typeof json.name !== 'string' ||
        json.name.length < 1 ||
        json.name.length > 32 ||
        json.name.trim() !== json.name
      ) {
        problems.push(`${where}: ad 1-32 karakter olmalı`);
      }
      if (json.description || json.options?.length) problems.push(`${where}: sağ tık komutunda açıklama/seçenek olmaz`);
      body.push(json);
      continue;
    }
    checkName(json.name, where, problems);
    checkDescription(json.description, where, problems);
    checkOptions(json.options, where, problems);
    checkDepth(json.options, where, problems);
    if (countChars(json) > MAX_TOTAL_CHARS) problems.push(`${where}: toplam metin ${MAX_TOTAL_CHARS} karakteri aşıyor`);
    body.push(json);
  }
  // Discord counts slash commands and each kind of context menu command separately.
  const ofType = (t) => body.filter((c) => (c.type ?? 1) === t);
  if (ofType(1).length > MAX_GLOBAL_COMMANDS) problems.push(`En fazla ${MAX_GLOBAL_COMMANDS} komut kaydedilebilir`);
  for (const t of [2, 3]) {
    if (ofType(t).length > MAX_CONTEXT_COMMANDS)
      problems.push(`En fazla ${MAX_CONTEXT_COMMANDS} sağ tık komutu olabilir`);
  }
  for (const t of [1, 2, 3]) {
    const names = ofType(t).map((c) => c.name);
    for (const name of new Set(names)) {
      if (names.filter((n) => n === name).length > 1) problems.push(`/${name}: iki kez tanımlanmış`);
    }
  }
  return { body, problems };
}
