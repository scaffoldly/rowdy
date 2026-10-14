import * as fsp from 'fs/promises';

/** What one vendored test file did in one store. */
export type Outcome =
  | { status: 'passed'; ms: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; ms: number; why: string; output: string };

export type Row = { file: string; exercises: string; outcome: Outcome };

export type Report = {
  node: string;
  flavour: string;
  arch: string;
  /** The column header, and where the tmpdir lived, for the headline. */
  store: { label: string; where: string };
  rows: Row[];
};

const FUNCTIONS = new Set(
  Object.entries(fsp)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
);

const HANDLE_METHODS = new Set([
  'appendFile',
  'chmod',
  'chown',
  'close',
  'createReadStream',
  'createWriteStream',
  'datasync',
  'read',
  'readableWebStream',
  'readFile',
  'readLines',
  'readv',
  'stat',
  'sync',
  'truncate',
  'utimes',
  'write',
  'writeFile',
  'writev',
]);

const PROMISES_MODULE = String.raw`['"](?:node:)?fs/promises['"]`;

/** The names a test file binds to the fs/promises module, besides `fs.promises`. */
const aliases = (source: string): string[] => {
  const names = new Set<string>();
  const patterns = [
    new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*require\(${PROMISES_MODULE}\)`, 'g'),
    new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+${PROMISES_MODULE}`, 'g'),
    /(?:const|let|var)\s+(\w+)\s*=\s*fs\.promises\b/g,
    /\{\s*promises\s*:\s*(\w+)\s*\}\s*=\s*(?:fs|require\(['"](?:node:)?fs['"]\))/g,
    /\{\s*(promises)\s*\}\s*=\s*(?:fs|require\(['"](?:node:)?fs['"]\))/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) names.add(match[1]!);
  return [...names];
};

/** The fs/promises functions and FileHandle methods a test file calls, for the summary's second column. */
export const exercises = (source: string): string => {
  const functions = new Set<string>();
  const add = (name: string): void => {
    if (FUNCTIONS.has(name)) functions.add(name);
  };
  const receivers = ['fs\\.promises', ...aliases(source)].join('|');
  for (const match of source.matchAll(new RegExp(String.raw`\b(?:${receivers})\.(\w+)\s*\(`, 'g'))) add(match[1]!);
  const destructured = new RegExp(
    String.raw`(?:const|let)\s*\{([^}]+)\}\s*=\s*(?:(?:${receivers})(?![\w.])|require\(${PROMISES_MODULE}\))`,
    'g'
  );
  for (const match of source.matchAll(destructured)) {
    for (const part of match[1]!.split(',')) add(part.split(':')[0]!.trim());
  }
  for (const match of source.matchAll(new RegExp(String.raw`import\s*\{([^}]+)\}\s*from\s*${PROMISES_MODULE}`, 'g'))) {
    for (const part of match[1]!.split(',')) add(part.trim().split(/\s+as\s+/)[0]!);
  }
  const methods = new Set<string>();
  for (const match of source.matchAll(/\b(?:fileHandle|filehandle|handle|fh)\.(\w+)\s*\(/g)) {
    if (HANDLE_METHODS.has(match[1]!)) methods.add(match[1]!);
  }
  const parts = [];
  if (functions.size) parts.push([...functions].sort().join(', '));
  if (methods.size) parts.push(`FileHandle ${[...methods].sort().join(', ')}`);
  return parts.join(' · ') || '–';
};

const cell = (outcome: Outcome): string => {
  switch (outcome.status) {
    case 'passed':
      return `✅ ${outcome.ms < 1000 ? `${outcome.ms} ms` : `${(outcome.ms / 1000).toFixed(1)}s`}`;
    case 'skipped':
      return `⏭️ ${outcome.reason}`;
    case 'failed':
      return `❌ ${outcome.why}`;
  }
};

const escape = (text: string): string => text.replace(/\|/g, '\\|');

/** The GitHub step summary: a headline, one row per test file, and the output of each failure. */
export const markdown = ({ node, flavour, arch, store, rows }: Report): string => {
  const failed = rows.flatMap(({ file, outcome }) => (outcome.status === 'failed' ? [{ file, outcome }] : []));
  const skipped = rows.filter((row) => row.outcome.status === 'skipped');
  const passed = rows.length - failed.length;
  const lines = [
    `### ${failed.length ? '❌' : '✅'} node ${node} fs/promises tests · ${flavour} · ${arch}`,
    '',
    `**${passed}/${rows.length} passed**` +
      (skipped.length ? ` (${skipped.length} skipped by node itself)` : '') +
      ": node's own `test-fs*` files that use `fs/promises`, each in its own `node` as the unprivileged" +
      ` \`node\` user, with its tmpdir on ${store.where}.`,
    '',
    `| test | what it exercises | ${store.label} |`,
    '|---|---|---|',
    ...rows.map((row) => `| \`${row.file}\` | ${escape(row.exercises)} | ${escape(cell(row.outcome))} |`),
    '',
  ];
  for (const { file, outcome } of failed) {
    lines.push(
      `<details><summary>❌ <code>${file}</code>: ${outcome.why}</summary>`,
      '',
      '```',
      outcome.output,
      '```',
      '</details>',
      ''
    );
  }
  return lines.join('\n');
};
