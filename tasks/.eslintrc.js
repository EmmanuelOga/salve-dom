module.exports = {
  extends: "lddubeau-base",
  parserOptions: {
    sourceType: "script"
  },
  env: {
    node: true,
  },
  rules: {
    "import/no-extraneous-dependencies": "off",
  }
};
