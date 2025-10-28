// Generic text file transformer for jest
module.exports = {
  process(sourceText) {
    return { code: `module.exports = ${JSON.stringify(sourceText)};` };
  },
};
