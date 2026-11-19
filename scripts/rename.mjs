#!/usr/bin/env node
/**
 * Renames the template's placeholder server across the repository, once:
 *
 *   example  -> <name>       (package, tool prefix, directories, file names)
 *   Example  -> <Name>       (class names, display text)
 *   EXAMPLE  -> <PREFIX>     (environment variables, constants)
 *
 * Usage: node scripts/rename.mjs <name> [PREFIX] [--dry-run]
 *
 * <name> is one lowercase word (letters and digits), e.g. `acme`. PREFIX
 * defaults to the upper-cased name. The file name `.env.example` (its
 * content is renamed), LICENSE, .git, node_modules and dist are left alone.
 *
 * `<npm-package>` becomes `mcp-server-<name>`. Every target path is checked
 * before anything is written.
 *
 * Template-only parts are removed: blocks between `template:start` and
 * `template:end` markers (README.md, .github/workflows/ci.yml) and this
 * script itself. The remaining checklist is in docs/NEW-SERVER.md.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER_PACKAGE = 'mcp-server-example';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [name, prefixArg] = args.filter(arg => !arg.startsWith('--'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!name || !/^[a-z][a-z0-9]*$/.test(name) || name === 'example') {
  fail(
    'Usage: node scripts/rename.mjs <name> [PREFIX] [--dry-run]\n' +
      '<name> must be one lowercase word of letters and digits other than "example", e.g. acme.',
  );
}
const prefix = prefixArg ?? name.toUpperCase();
if (!/^[A-Z](?:[A-Z0-9_]*[A-Z0-9])?$/.test(prefix) || prefix === 'EXAMPLE') {
  fail('PREFIX must be upper case letters, digits and underscores, e.g. ACME (no trailing underscore).');
}
const title = name.charAt(0).toUpperCase() + name.slice(1);

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.name !== PLACEHOLDER_PACKAGE) {
  fail(
    `package.json is named ${JSON.stringify(pkg.name)}, not ${PLACEHOLDER_PACKAGE}: the placeholder has ` +
      'already been renamed. Nothing changed. Delete scripts/rename.mjs.',
  );
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const SKIP_FILES = new Set(['LICENSE']);
/** Text (and file name) that contains the word but is not the placeholder. */
const PROTECTED = '.env.example';
/** Marker-delimited template-only blocks, in Markdown or YAML comments. */
const TEMPLATE_BLOCKS = [
  /\n<!-- template:start -->[\s\S]*?<!-- template:end -->\n\n?/g,
  /\n# template:start\n[\s\S]*?# template:end\n/g,
];

const REPLACEMENTS = { EXAMPLE: prefix, Example: title, example: name };
/** Stands for the npm package name in README commands until the rename sets it. */
const PACKAGE_TOKEN = '<npm-package>';

/** One pass, so a new name that contains the placeholder is not substituted twice. */
function replaceAll(text) {
  return text
    .split(PROTECTED)
    .map(part => part.replace(/EXAMPLE|Example|example/g, match => REPLACEMENTS[match]))
    .join(PROTECTED);
}

function walk(dir, files = [], dirs = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        dirs.push(path);
        walk(path, files, dirs);
      }
    } else if (entry.isFile() && path !== self && !SKIP_FILES.has(entry.name)) {
      files.push(path);
    }
  }
  return { files, dirs };
}

function isText(buffer) {
  return !buffer.subarray(0, 8000).includes(0);
}

const { files, dirs } = walk(root);

// Plan everything first; nothing is written unless every step can be done.
const edits = [];
for (const file of files) {
  const buffer = readFileSync(file);
  if (!isText(buffer)) {
    continue;
  }
  const original = buffer.toString('utf8');
  let updated = original;
  for (const block of TEMPLATE_BLOCKS) {
    updated = updated.replace(block, '\n');
  }
  updated = replaceAll(updated).split(PACKAGE_TOKEN).join(`mcp-server-${name}`);
  if (updated !== original) {
    edits.push({ file, updated });
  }
}

// Files, then directories, deepest first so parent paths stay valid. Each
// target is checked against the original tree, which is where it lands.
const renames = [...files, ...dirs]
  .filter(path => basename(path).includes('example') && basename(path) !== PROTECTED)
  .sort((a, b) => b.length - a.length)
  .map(path => ({ path, target: join(dirname(path), replaceAll(basename(path))) }));
const conflicts = renames.filter(
  ({ target }, index) => existsSync(target) || renames.findIndex(other => other.target === target) !== index,
);
if (conflicts.length > 0) {
  fail(
    `Refusing to rename: ${conflicts.map(({ target }) => relative(root, target)).join(', ')} already exist(s) ` +
      'or would be created twice. Nothing changed.',
  );
}

for (const { file, updated } of edits) {
  console.log(`edit   ${relative(root, file)}`);
  if (!dryRun) {
    writeFileSync(file, updated);
  }
}
for (const { path, target } of renames) {
  console.log(`rename ${relative(root, path)} -> ${relative(root, target)}`);
  if (!dryRun) {
    renameSync(path, target);
  }
}
const changed = edits.length;

console.log(`delete ${relative(root, self)}`);
if (!dryRun) {
  unlinkSync(self);
  const scripts = dirname(self);
  if (readdirSync(scripts).length === 0) {
    rmdirSync(scripts);
  }
}

console.log(
  `\n${dryRun ? 'Would change' : 'Changed'} ${changed} files and ${renames.length} paths: example -> ${name}, ` +
    `Example -> ${title}, EXAMPLE -> ${prefix}.`,
);
if (!dryRun) {
  console.log('Next: review `git diff`, run `npm ci && npm run typecheck && npm test && npm run build`,');
  console.log('and continue with docs/NEW-SERVER.md.');
}
