const globals = require("globals");
const eslint = require("@eslint/js");

module.exports = [
  eslint.configs.recommended,

  {
    files: ["**/*.js"],

    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },

    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unreachable": "error",
      eqeqeq: "error",
    },
  },

  {
    ignores: [
      "node_modules/",
      ".env",
      "uploads/",
      "dist/",
      "build/",
    ],
  },
];