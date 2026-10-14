import * as fsp from 'fs/promises';

/** What one vendored test file did in one store. */
export type Outcome =
  | { status: 'passed'; ms: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; ms: number; why: string; output: string };

/** One column: a store the tests ran on, or were skipped on. */
export type Column = {
  /** The column header. */
  label: string;
  /** Where the tests' tmpdir lives, for the headline. */
  where: string;
  /** Whether a failure here fails the run; otherwise it is only reported. */
  gate: boolean;
  /** Why the store did not run, when it did not. */
  skip?: string;
};

/** One test file: its outcome in each column, by label (none for a store that did not run). */
export type Row = { file: string; exercises: string; outcomes: Map<string, Outcome> };

export type Report = {
  node: string;
  flavour: string;
  arch: string;
  columns: Column[];
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

/** A ran column's tally: passed (node's own skips included) of all, and how many of those node skipped. */
const tally = (column: Column, rows: Row[]): string => {
  const outcomes = rows.flatMap((row) => row.outcomes.get(column.label) ?? []);
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped').length;
  return (
    `**${column.label}** ${rows.length - failed}/${rows.length} passed` +
    (skipped ? ` (${skipped} skipped by node itself)` : '') +
    ` on ${column.where}` +
    (column.gate ? '' : ', reported only')
  );
};

/** The GitHub step summary: a headline, one row per test file and column per store, and each failure's output. */
export const markdown = ({ node, flavour, arch, columns, rows }: Report): string => {
  const failures = columns.flatMap((column) =>
    rows.flatMap(({ file, outcomes }) => {
      const outcome = outcomes.get(column.label);
      return outcome?.status === 'failed' ? [{ column, file, outcome }] : [];
    })
  );
  const ran = columns.filter((column) => !column.skip);
  const lines = [
    `### ${failures.some(({ column }) => column.gate) ? '❌' : '✅'} node ${node} fs/promises tests · ${flavour} · ${arch}`,
    '',
    "node's own `test-fs*` files that use `fs/promises`, each in its own `node` as the unprivileged `node` user.",
    '',
    ...ran.map((column) => `- ${tally(column, rows)}`),
    ...columns.flatMap((column) => (column.skip ? [`- _**${column.label}** skipped: ${column.skip}._`] : [])),
    '',
    `| test | what it exercises | ${columns.map((column) => column.label).join(' | ')} |`,
    `|---|---|${columns.map(() => '---|').join('')}`,
    ...rows.map(
      (row) =>
        `| \`${row.file}\` | ${escape(row.exercises)} | ` +
        columns
          .map((column) => {
            const outcome = row.outcomes.get(column.label);
            return outcome ? escape(cell(outcome)) : '–';
          })
          .join(' | ') +
        ' |'
    ),
    '',
  ];
  for (const { column, file, outcome } of failures) {
    lines.push(
      `<details><summary>❌ <b>${column.label}</b> <code>${file}</code>: ${outcome.why}</summary>`,
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
