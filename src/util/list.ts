import * as YAML from 'yaml';

/** The entries of a list option: a YAML list, or one entry per line with `#` comments. */
export const specList = (value: string): Array<string> => {
  let parsed: unknown;
  try {
    parsed = YAML.parse(value);
  } catch {
    parsed = undefined;
  }
  const entries = Array.isArray(parsed)
    ? parsed.map((entry) => String(entry))
    : value.split(/\r?\n/).filter((line) => !line.trim().startsWith('#'));
  return entries.map((entry) => entry.trim()).filter(Boolean);
};
