import dotenv from 'dotenv';

export type Secrets = Record<string, string>;

const DOTENV = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// DEVNOTE: Errors name the line number only; the line itself may be a secret.
const invalidLine = (line: number) => new Error(`secrets: line ${line} is neither NAME=value nor a JSON object`);
const invalidObject = (line: number) => new Error(`secrets: line ${line} starts a JSON object that is not valid`);

// DEVNOTE: A value that is a whole JSON string, as `${{ toJSON(secrets.X) }}` expands to, is decoded
// as JSON so every escape round-trips. Other quoted values go through dotenv. An unquoted value ends
// at ` #` (a comment) but keeps a bare `#`, which dotenv would cut at, silently truncating a secret.
const dotenvValue = (name: string, line: string, raw: string): string => {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      // not JSON; dotenv decides
    }
  }
  if (/^["'`]/.test(value)) return dotenv.parse(line.trim())[name] ?? '';
  return value.replace(/\s+#.*$/, '');
};

/** The index just past the `}` closing the object that opens at `start`, or -1. */
const closing = (text: string, start: number): number => {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '\\') i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return i + 1;
    }
  }
  return -1;
};

const object = (json: string, line: number): Secrets => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalidObject(line);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidObject(line);
  return Object.entries(parsed).reduce((secrets, [name, value]) => {
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw invalidObject(line);
    secrets[name] = String(value);
    return secrets;
  }, {} as Secrets);
};

/** Every JSON object in `text`, in order. Anything else but blank lines and `#` comments is an error. */
const objects = (text: string): Secrets[] => {
  const found: Secrets[] = [];
  const endOfLine = (from: number): number => {
    const end = text.indexOf('\n', from);
    return end === -1 ? text.length : end;
  };

  let offset = 0;
  let line = 1;
  while (offset < text.length) {
    const end = endOfLine(offset);
    const content = text.slice(offset, end).trim();

    if (content.startsWith('{')) {
      const start = text.indexOf('{', offset);
      const close = closing(text, start);
      if (close === -1 || text.slice(close, endOfLine(close)).trim()) throw invalidObject(line);
      found.push(object(text.slice(start, close), line));
      line += text.slice(offset, close).split('\n').length - 1;
      offset = close;
      continue;
    }

    if (content && !content.startsWith('#')) throw invalidLine(line);

    offset = end + 1;
    line++;
  }
  return found;
};

/**
 * Secrets from `NAME=value` lines and JSON objects (such as `${{ toJSON(secrets) }}`), in any mix.
 * JSON objects apply in order, then `NAME=value` lines on top, so a line always wins.
 */
export const parseSecrets = (input: string, options: { onOverride?: (name: string) => void } = {}): Secrets => {
  const lines: Secrets[] = [];
  // DEVNOTE: Matched lines are blanked rather than removed, so JSON errors keep their line numbers.
  const remaining = input
    .split('\n')
    .map((line) => {
      const match = DOTENV.exec(line);
      if (!match) return line;
      lines.push({ [match[1]!]: dotenvValue(match[1]!, line, match[2]!) });
      return '';
    })
    .join('\n');

  const secrets: Secrets = {};
  [...objects(remaining), ...lines].forEach((entries) =>
    Object.entries(entries).forEach(([name, value]) => {
      if (name in secrets) options.onOverride?.(name);
      secrets[name] = value;
    })
  );
  return secrets;
};
