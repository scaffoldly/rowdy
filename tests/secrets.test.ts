import { parseSecrets } from '../src/secrets';

// DEVNOTE: Inputs are written the way GitHub hands them over: the `secrets: |` block with every
// `${{ … }}` already expanded. `toJSON(secrets)` expands to a pretty-printed object.
describe('secrets', () => {
  const repo = `{
  "API_KEY": "from-repo",
  "DATABASE_URL": "postgres://db.example.com/app"
}`;

  it('combines NAME=value lines with all repo secrets', () => {
    const input = `
SENTRY_DSN=https://key@sentry.example.com/1
${repo}
BUILD_ID=20261007.1
`;
    expect(parseSecrets(input)).toEqual({
      SENTRY_DSN: 'https://key@sentry.example.com/1',
      API_KEY: 'from-repo',
      DATABASE_URL: 'postgres://db.example.com/app',
      BUILD_ID: '20261007.1',
    });
  });

  it('lets a NAME=value line override a repo secret, wherever it sits', () => {
    expect(parseSecrets(`API_KEY=from-line\n${repo}`).API_KEY).toBe('from-line');
    expect(parseSecrets(`${repo}\nAPI_KEY=from-line`).API_KEY).toBe('from-line');
  });

  it('keeps the repo secret when a line for it expands to nothing', () => {
    // DATABASE_URL=${{ secrets.DATABASE_ULR }}: misspelled, so GitHub expands it to nothing
    expect(parseSecrets(`DATABASE_URL=\n${repo}`).DATABASE_URL).toBe('postgres://db.example.com/app');
  });

  it('reports overridden names, never values', () => {
    const overridden: string[] = [];
    parseSecrets(`API_KEY=from-line\n${repo}`, { onOverride: (name) => overridden.push(name) });
    expect(overridden).toEqual(['API_KEY']);
  });

  describe('NAME=value', () => {
    it('reads one secret per line', () => {
      const input = `
DATABASE_URL=postgres://db.example.com/app
API_KEY=abc123
`;
      expect(parseSecrets(input)).toEqual({ DATABASE_URL: 'postgres://db.example.com/app', API_KEY: 'abc123' });
    });

    it('keeps everything after the first =', () => {
      expect(parseSecrets('QUERY=a=1&b=2')).toEqual({ QUERY: 'a=1&b=2' });
    });

    it('drops a trailing # comment', () => {
      expect(parseSecrets('PASSWORD=hunter2 # rotated monthly')).toEqual({ PASSWORD: 'hunter2' });
    });

    it('keeps a # that is not preceded by a space', () => {
      expect(parseSecrets('PASSWORD=abc#123')).toEqual({ PASSWORD: 'abc#123' });
      expect(parseSecrets('DOCS_URL=https://example.com/guide#setup')).toEqual({
        DOCS_URL: 'https://example.com/guide#setup',
      });
    });

    it('treats a space then # as a comment, so quote a value that has one', () => {
      expect(parseSecrets('PASSWORD=abc #123')).toEqual({ PASSWORD: 'abc' });
      expect(parseSecrets('PASSWORD="abc #123" # rotated monthly')).toEqual({ PASSWORD: 'abc #123' });
      expect(parseSecrets("PASSWORD='abc #123'")).toEqual({ PASSWORD: 'abc #123' });
    });

    it('accepts export, as in a .env file', () => {
      expect(parseSecrets('export API_KEY=abc123')).toEqual({ API_KEY: 'abc123' });
    });

    it('strips quotes around a value', () => {
      expect(parseSecrets(`SINGLE='abc 123'\nDOUBLE="abc 123"`)).toEqual({ SINGLE: 'abc 123', DOUBLE: 'abc 123' });
    });

    it('decodes a toJSON value exactly, for secrets that span lines or hold quotes', () => {
      // KEY=${{ toJSON(secrets.KEY) }}
      expect(parseSecrets('KEY="-----BEGIN KEY-----\\nMIIB\\n-----END KEY-----"')).toEqual({
        KEY: '-----BEGIN KEY-----\nMIIB\n-----END KEY-----',
      });
      expect(parseSecrets('QUOTE="say \\"hi\\" #1 \\\\ ok"')).toEqual({ QUOTE: 'say "hi" #1 \\ ok' });
    });

    it('skips an empty value, which is what a missing secret expands to', () => {
      const skipped: string[] = [];
      expect(parseSecrets('API_KEY=\nCOMMENTED= # rotated monthly', { onEmpty: (name) => skipped.push(name) })).toEqual(
        {}
      );
      expect(skipped).toEqual(['API_KEY', 'COMMENTED']);
    });

    it('sets an empty value when it is quoted', () => {
      expect(parseSecrets(`DOUBLE=""\nSINGLE=''`)).toEqual({ DOUBLE: '', SINGLE: '' });
    });

    it('skips blank lines and comments', () => {
      const input = `
# Payments
STRIPE_KEY=sk_test_123

# Email
SMTP_PASSWORD=hunter2
`;
      expect(parseSecrets(input)).toEqual({ STRIPE_KEY: 'sk_test_123', SMTP_PASSWORD: 'hunter2' });
    });
  });

  describe('JSON objects', () => {
    it('reads a one-line JSON object, as secrets: ${{ toJSON(secrets) }} always has', () => {
      expect(parseSecrets('{"API_KEY":"abc123","DATABASE_URL":"postgres://db.example.com/app"}')).toEqual({
        API_KEY: 'abc123',
        DATABASE_URL: 'postgres://db.example.com/app',
      });
    });

    it('reads the pretty-printed object toJSON(secrets) expands to', () => {
      expect(parseSecrets(repo)).toEqual({ API_KEY: 'from-repo', DATABASE_URL: 'postgres://db.example.com/app' });
    });

    it('reads several objects, later ones winning', () => {
      // ${{ toJSON(vars) }} then ${{ toJSON(secrets) }}
      expect(parseSecrets(`{"API_KEY": "from-vars", "REGION": "us-east-1"}\n${repo}`)).toEqual({
        API_KEY: 'from-repo',
        REGION: 'us-east-1',
        DATABASE_URL: 'postgres://db.example.com/app',
      });
    });

    it('is not confused by braces, quotes or = inside values', () => {
      const input = `{
  "TEMPLATE": "Hello {name}, say \\"}\\" please",
  "QUERY": "a=1&b=2"
}`;
      expect(parseSecrets(input)).toEqual({ TEMPLATE: 'Hello {name}, say "}" please', QUERY: 'a=1&b=2' });
    });

    it('turns numbers and booleans into strings', () => {
      expect(parseSecrets('{"PORT": 8080, "DEBUG": false}')).toEqual({ PORT: '8080', DEBUG: 'false' });
    });

    it('keeps newlines in values', () => {
      expect(parseSecrets('{"KEY": "line one\\nline two"}')).toEqual({ KEY: 'line one\nline two' });
    });
  });

  describe('errors', () => {
    it('names the line number but never prints the line', () => {
      // KEY=${{ secrets.KEY }} with a multi-line value: only the first line is NAME=value
      const input = `
KEY=-----BEGIN KEY-----
MIIB
-----END KEY-----
`;
      expect(() => parseSecrets(input)).toThrow('secrets: line 3 is neither NAME=value nor a JSON object');
      expect(() => parseSecrets(input)).not.toThrow(/MIIB/);
    });

    it('rejects a name that is not a valid environment variable', () => {
      expect(() => parseSecrets('API-KEY=abc123')).toThrow('secrets: line 1 is neither NAME=value nor a JSON object');
    });

    it('rejects an unclosed JSON object by the line it starts on', () => {
      expect(() => parseSecrets('API_KEY=abc123\n{\n  "DB": "x"\n')).toThrow(
        'secrets: line 2 starts a JSON object that is not valid'
      );
    });

    it('rejects a nested value, since an environment variable is a string', () => {
      expect(() => parseSecrets('{"DB": {"user": "app"}}')).toThrow(
        'secrets: line 1 starts a JSON object that is not valid'
      );
    });
  });
});
