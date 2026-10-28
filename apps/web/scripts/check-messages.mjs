// Checks the message files (W-D5): every language has exactly the English
// keys, every message parses as ICU, the placeholders match, and every key a
// component asks for exists.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src/', import.meta.url).pathname;
const languages = ['en', 'ar'];
const problems = [];

function flatten(value, prefix = '', out = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') out[path] = child;
    else flatten(child, path, out);
  }
  return out;
}

function placeholders(message) {
  // ICU arguments start at "{" in text (even depth); at odd depth "{" opens a plural or select branch.
  const names = new Set();
  let depth = 0;
  for (let index = 0; index < message.length; index += 1) {
    const char = message[index];
    if (char === '{') {
      if (depth % 2 === 0) {
        const match = /^\{\s*([A-Za-z_]\w*)\s*[,}]/.exec(message.slice(index));
        if (!match) return null;
        names.add(match[1]);
      }
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth < 0) return null;
    }
  }
  return depth === 0 ? names : null;
}

const messages = {};
const namespaces = readdirSync(join(root, 'messages/en')).filter((file) => file.endsWith('.json'));
for (const language of languages) {
  messages[language] = {};
  for (const file of namespaces) {
    const namespace = file.replace(/\.json$/, '');
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(root, `messages/${language}/${file}`), 'utf8'));
    } catch (error) {
      problems.push(`${language}/${file}: ${error.message}`);
      continue;
    }
    Object.assign(messages[language], flatten(parsed, namespace));
  }
}

const load = readFileSync(join(root, 'messages/load.ts'), 'utf8');
for (const file of namespaces) {
  if (!load.includes(`'${file.replace(/\.json$/, '')}'`)) problems.push(`messages/load.ts does not load ${file}`);
}

const english = messages.en;
for (const language of languages.slice(1)) {
  const other = messages[language];
  for (const key of Object.keys(english)) {
    if (!(key in other)) problems.push(`${language}: missing ${key}`);
  }
  for (const key of Object.keys(other)) {
    if (!(key in english)) problems.push(`${language}: extra ${key}`);
  }
}
for (const language of languages) {
  for (const [key, message] of Object.entries(messages[language])) {
    const names = placeholders(message);
    if (names === null) {
      problems.push(`${language}: unbalanced braces in ${key}`);
      continue;
    }
    if (language !== 'en' && key in english) {
      const expected = placeholders(english[key]) ?? new Set();
      for (const name of expected) if (!names.has(name)) problems.push(`${language}: ${key} lacks {${name}}`);
      for (const name of names) if (!expected.has(name)) problems.push(`${language}: ${key} has unknown {${name}}`);
    }
  }
}

// Static keys used in components: t('key') after useTranslations('namespace').
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(tsx?|mjs)$/.test(entry.name) ? [path] : [];
  });
}
for (const file of walk(root)) {
  const source = readFileSync(file, 'utf8');
  const bindings = new Map();
  for (const match of source.matchAll(/const (\w+) = (?:await )?(?:useTranslations|getTranslations)\('([\w.]+)'\)/g)) bindings.set(match[1], match[2]);
  for (const [name, namespace] of bindings) {
    const pattern = new RegExp(`\\b${name}(?:\\.rich|\\.markup)?\\('([\\w.]+)'`, 'g');
    for (const match of source.matchAll(pattern)) {
      const key = `${namespace}.${match[1]}`;
      if (!(key in english)) problems.push(`${file.slice(root.length)}: unknown message ${key}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} message problem(s).`);
  process.exit(1);
}
console.log(`Messages OK: ${Object.keys(english).length} keys × ${languages.length} languages.`);
