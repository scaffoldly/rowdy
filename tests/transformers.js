// Jest counterpart of tsup's `.so` -> 'binary' esbuild loader: the import
// resolves to a Uint8Array of the file's contents.
module.exports = {
  process(_src, filename) {
    return {
      code: `module.exports = { __esModule: true, default: new Uint8Array(require('fs').readFileSync(${JSON.stringify(filename)})) };`,
    };
  },
};
