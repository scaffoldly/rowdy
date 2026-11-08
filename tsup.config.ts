import { defineConfig, type Options } from 'tsup';

const shared: Options = {
  sourcemap: 'inline',
  target: 'esnext',
  shims: true,
  // `rowdy mcp` loads its server on demand: everything else, a cold start included, shouldn't parse it.
  splitting: true,
  // tsup leaves peers external by default. These are optional, so requiring one at load would crash without it.
  noExternal: ['zod', '@modelcontextprotocol/server', 'rxjs'],
};

export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts', 'src/sandbox/index.ts'],
    dts: { resolve: [/^@scaffoldly\/rowdy-cdk/] },
    format: ['cjs'],
    cjsInterop: true,
  },
  // An ESM host, like a Cloudflare Worker, has no `__filename` or `require` for the CommonJS build to use.
  {
    ...shared,
    entry: { index: 'src/sandbox/index.ts' },
    outDir: 'dist/esm/sandbox',
    format: ['esm'],
    // A Worker has no `import.meta.url` either, so a shim for `__dirname` would crash at load.
    shims: false,
    // Bundled CommonJS dependencies still `require` Node's built-ins.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url ?? 'file:///');",
    },
  },
]);
