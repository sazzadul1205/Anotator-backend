const globals = require("globals");
const eslint = require("@eslint/js");

module.exports = [
  eslint.configs.recommended,

  // Only lint JavaScript source files
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

  // Files/folders that should NOT be checked
  {
    ignores: [
      "node_modules/**",
      ".env",
      ".env.*",

      // Generated/build output
      "build/**",
      "dist/**",
      "out/**",

      // Uploaded/user-generated files
      "uploads/**",

      // Logs
      "logs/**",
      "*.log",

      // Coverage/test output
      "coverage/**",

      // Cache/temp files
      ".cache/**",
      ".tmp/**",
      "tmp/**",
      "temp/**",

      // Other generated files
      "*.min.js",
    ],
  },
];
