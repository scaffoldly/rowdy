#!/usr/bin/env node

export const hello = (): string => {
  return 'Hello, World!';
};

const main = async (): Promise<void> => {
  process.stdout.write(hello());
  process.stdout.write('\n');
};

const error = (err: unknown): void => {
  process.stderr.write(
    `Error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
};

if (require.main === module) {
  main().catch(error);
}
