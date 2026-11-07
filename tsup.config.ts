import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/sandbox/index.ts'],
  sourcemap: 'inline',
  dts: { resolve: [/^@scaffoldly\/rowdy-cdk/] },
  format: ['cjs'],
  target: 'esnext',
  cjsInterop: true,
  shims: true,
  // tsup leaves peers external by default. These are optional, so requiring one at load would crash without it.
  noExternal: ['zod', '@modelcontextprotocol/server'],
});
