# Secrets

`secrets` sets environment variables on the deployed function. It takes `NAME=value` lines and JSON
objects, in any mix, so the common case (every repository secret plus one or two more) reads as a
short list:

```yaml
- uses: scaffoldly/rowdy@github
  with:
    cloud: aws
    compute: lambda
    dockerfile: ./Dockerfile
    secrets: |
      SENTRY_DSN=${{ vars.SENTRY_DSN }}
      ${{ toJSON(secrets) }}
      BUILD_ID=${{ github.run_id }}
```

The same input is `--secrets` on `rowdy create`, or the `ROWDY_SECRETS` environment variable.

GitHub expands every `${{ … }}` before rowdy sees the input, so the examples below show the text
rowdy actually reads.

## Syntax

The input is read line by line.

1. A line of the form `NAME=value`, optionally prefixed with `export `, is a secret. `NAME` must be
   a valid environment variable name: `[A-Za-z_][A-Za-z0-9_]*`.
2. A line whose first non-space character is `{` starts a JSON object, which runs to its matching
   `}` and may span lines. `${{ toJSON(secrets) }}` expands to exactly this:

   ```
   {
     "github_token": "***",
     "API_KEY": "abc123",
     "DATABASE_URL": "postgres://db.example.com/app"
   }
   ```

   Values must be strings; numbers and booleans are turned into strings. Several objects are fine,
   such as `${{ toJSON(vars) }}` followed by `${{ toJSON(secrets) }}`.

3. Blank lines and lines starting with `#` are skipped.

Anything else fails the deploy (see [What fails the deploy](#what-fails-the-deploy)).

A plain `${{ toJSON(secrets) }}`, the only form accepted before, works unchanged.

## Precedence

JSON objects apply first, in order, so a later object overrides an earlier one. `NAME=value` lines
apply on top, in order, so **a line always overrides a repository secret**, wherever it sits:

```
API_KEY=from-line
{
  "API_KEY": "from-repo"
}
```

sets `API_KEY` to `from-line`.

`github_token`, which GitHub adds to `secrets`, is always dropped.

## Values

A value is everything after the first `=`, trimmed.

| Line                                       | Value                             |
| ------------------------------------------ | --------------------------------- |
| `QUERY=a=1&b=2`                            | `a=1&b=2`                         |
| `PASSWORD=hunter2 # rotated monthly`       | `hunter2`                         |
| `PASSWORD=abc#123`                         | `abc#123`                         |
| `DOCS_URL=https://example.com/guide#setup` | `https://example.com/guide#setup` |
| `PASSWORD="abc #123" # rotated monthly`    | `abc #123`                        |
| `PASSWORD='abc #123'`                      | `abc #123`                        |
| `export API_KEY=abc123`                    | `abc123`                          |
| `API_KEY=`                                 | skipped, with a warning           |
| `API_KEY=""`                               | empty string                      |

- **Comments.** In an unquoted value, a space followed by `#` starts a comment. A `#` with no space
  before it is part of the value, so a generated password or a URL fragment is never cut short.
- **Quotes.** A quoted value is read by [dotenv](https://github.com/motdotla/dotenv): the quotes are
  removed and anything after the closing quote is a comment. Quote a value that contains ` #`.
- **Empty.** An unset or misspelled `${{ secrets.X }}` expands to nothing, so `API_KEY=` is skipped
  rather than setting an empty variable that would override the real value from
  `${{ toJSON(secrets) }}`. rowdy logs `Secret Skipped` at `warn` with the name (never a value). To
  set a variable to the empty string on purpose, quote it: `API_KEY=""`.

## Multi-line and quoted secrets

A secret with newlines, such as a PEM key, breaks the line format when pasted raw: only its first
line is `NAME=value`, and the next line fails the deploy. Pass it through `toJSON` instead:

```yaml
secrets: |
  TLS_KEY=${{ toJSON(secrets.TLS_KEY) }}
```

`toJSON` turns the value into one line, `"-----BEGIN KEY-----\nMIIB…\n-----END KEY-----"`. A value
that is a whole JSON string is decoded as JSON, so newlines, quotes and backslashes come back
exactly. This form is safe for any secret whose contents you do not control.

## What fails the deploy

The error names the line number, never the line, since the line may hold a secret.

| Error                                                     | Cause                                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `secrets: line N is neither NAME=value nor a JSON object` | A multi-line value pasted raw, a name that is not a valid variable name (`API-KEY=…`), or stray text. |
| `secrets: line N starts a JSON object that is not valid`  | An object with no closing `}`, invalid JSON, or a value that is an object or array.                   |

## Logs

Rowdy never logs a secret's value. When one entry overrides another, it logs the name at `debug`:
`withSecrets(overridden=API_KEY)`. Variables are logged masked when the function's environment is
set.

## Updating a deployment

Each deploy sets the variables it is given on the function, and keeps any the function already has.
Removing a line from `secrets` therefore does not remove the variable from a deployed function;
delete it from the function's configuration to remove it.
