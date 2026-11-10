// Komut tanımlarını Discord'un kurallarına göre denetler ("npm run deploy-commands -- --check").
// Normalde dokunmana gerek yok.
//
// Builds the JSON sent to Discord and checks it against Discord's documented limits, so
// mistakes are caught locally (without a token) instead of as a 400 from the API.

const NAME_PATTERN = /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;
const MAX_GLOBAL_COMMANDS = 100;
const MAX_OPTIONS = 25;
const MAX_CHOICES = 25;
const MAX_TOTAL_CHARS = 4000;

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

function countChars(option) {
  let total = (option.name?.length ?? 0) + (option.description?.length ?? 0);
  for (const choice of option.choices ?? []) total += choice.name.length + String(choice.value).length;
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
    const where = `/${json.name}`;
    checkName(json.name, where, problems);
    checkDescription(json.description, where, problems);
    checkOptions(json.options, where, problems);
    if (countChars(json) > MAX_TOTAL_CHARS) problems.push(`${where}: toplam metin ${MAX_TOTAL_CHARS} karakteri aşıyor`);
    body.push(json);
  }
  if (body.length > MAX_GLOBAL_COMMANDS) problems.push(`En fazla ${MAX_GLOBAL_COMMANDS} komut kaydedilebilir`);
  const names = body.map((c) => c.name);
  for (const name of new Set(names)) {
    if (names.filter((n) => n === name).length > 1) problems.push(`/${name}: iki kez tanımlanmış`);
  }
  return { body, problems };
}
