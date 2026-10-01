// aisdlc-nodejs standards as ESLint flat-config objects, using core ESLint rules only (ESLint 9 or later).
// Copied into the project by /aisdlc-nodejs:register. Append it to the project's own configuration:
//
//   import aisdlcStandards from './eslint.aisdlc.mjs';
//   export default [...projectConfig, ...aisdlcStandards({ sourceType: 'module' })];
//
// In a CommonJS `eslint.config.js`: `const aisdlcStandards = require('./eslint.aisdlc.mjs').default;` (Node.js 24).
//
// It sets `no-restricted-syntax`, `no-restricted-imports`, `no-restricted-properties` and `no-restricted-globals`.
// ESLint replaces a rule's options rather than merging them, so a project that sets one of these rules itself adds
// its own entries through the matching option (for example `restrictedSyntax`) instead of a separate config object.
//
// What this can't check (class modules, constants grouped under constant/, floating promises without type
// information) stays with review against the aisdlc-nodejs standards skill.
import { builtinModules } from 'node:module';

const INLINE_FUNCTION_MESSAGE = 'No inline functions: declare an intention-revealing named function or method and pass its reference (aisdlc-nodejs standards).';
const NODE_PREFIX_MESSAGE = 'Import Node.js built-ins with the node: prefix (aisdlc-nodejs standards).';
const PROCESS_ENV_MESSAGE = 'Read process.env only in a config/ module, validate it at startup and inject the result (aisdlc-nodejs standards).';

// Where an arrow or anonymous function expression counts as inline: passed to a call or constructor, returned,
// set as an object property or a member, or returned from an arrow. Declarations, variables and class fields stay
// allowed, since they name the function.
const INLINE_FUNCTION_SELECTORS = [
  'CallExpression > ArrowFunctionExpression',
  'CallExpression > FunctionExpression[id=null]',
  'NewExpression > ArrowFunctionExpression',
  'NewExpression > FunctionExpression[id=null]',
  'ReturnStatement > ArrowFunctionExpression',
  'ReturnStatement > FunctionExpression[id=null]',
  'ArrowFunctionExpression > ArrowFunctionExpression.body',
  'ArrowFunctionExpression > FunctionExpression[id=null].body',
  'Property[method=false][kind="init"] > ArrowFunctionExpression.value',
  'Property[method=false][kind="init"] > FunctionExpression[id=null].value',
  'AssignmentExpression[left.type="MemberExpression"] > ArrowFunctionExpression.right',
  'AssignmentExpression[left.type="MemberExpression"] > FunctionExpression[id=null].right',
];

// CommonJS globals that ES modules don't have.
const COMMONJS_GLOBALS = [
  { name: '__dirname', message: 'Use import.meta.dirname in ES modules.' },
  { name: '__filename', message: 'Use import.meta.filename in ES modules.' },
  { name: 'require', message: 'Use import in ES modules; never mix require and import in one package.' },
  { name: 'module', message: 'Use export in ES modules.' },
  { name: 'exports', message: 'Use export in ES modules.' },
];

const DEFAULTS = {
  sourceType: 'module',
  files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
  configFiles: ['**/config/**'],
  testFiles: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'],
  restrictedSyntax: [],
  restrictedImports: [],
  restrictedProperties: [],
  restrictedGlobals: [],
};

function isUnprefixedBuiltin(name) {
  return !name.startsWith('node:') && !name.startsWith('_');
}

// Built-in names hold only letters, digits, `_` and `/`. The esquery in ESLint 9 can't parse an escaped `/` inside
// a selector's regular expression, so `.` stands in for it.
function toSelectorPattern(name) {
  return name.replaceAll('/', '.');
}

function toImportRestriction(name) {
  return { name, message: NODE_PREFIX_MESSAGE };
}

function toInlineFunctionRestriction(selector) {
  return { selector, message: INLINE_FUNCTION_MESSAGE };
}

// `require('fs')` in CommonJS files; `no-restricted-imports` covers import declarations.
function unprefixedRequireRestriction(builtins) {
  return {
    selector: `CallExpression[callee.name="require"] > Literal.arguments[value=/^(${builtins.map(toSelectorPattern).join('|')})$/]`,
    message: NODE_PREFIX_MESSAGE,
  };
}

export default function aisdlcStandards(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  if (!['module', 'commonjs'].includes(settings.sourceType)) throw new Error(`aisdlcStandards: sourceType must be "module" or "commonjs", not "${settings.sourceType}".`);
  const builtins = builtinModules.filter(isUnprefixedBuiltin);
  const moduleFiles = settings.sourceType === 'module' ? ['**/*.js', '**/*.mjs'] : ['**/*.mjs'];

  return [
    {
      name: 'aisdlc/linter-options',
      linterOptions: { reportUnusedDisableDirectives: 'error' },
    },
    {
      name: 'aisdlc/source-type',
      files: ['**/*.js'],
      languageOptions: { sourceType: settings.sourceType },
    },
    {
      name: 'aisdlc/standards',
      files: settings.files,
      rules: {
        'no-restricted-syntax': ['error', ...INLINE_FUNCTION_SELECTORS.map(toInlineFunctionRestriction), unprefixedRequireRestriction(builtins), ...settings.restrictedSyntax],
        'no-restricted-imports': ['error', { paths: [...builtins.map(toImportRestriction), ...settings.restrictedImports] }],
        'no-restricted-properties': ['error', { object: 'process', property: 'env', message: PROCESS_ENV_MESSAGE }, ...settings.restrictedProperties],
        'no-throw-literal': 'error',
        'prefer-promise-reject-errors': 'error',
        'no-empty': 'error',
        'no-async-promise-executor': 'error',
        'no-promise-executor-return': 'error',
        'no-console': 'error',
      },
    },
    {
      name: 'aisdlc/es-modules',
      files: moduleFiles,
      rules: {
        'no-restricted-globals': ['error', ...COMMONJS_GLOBALS, ...settings.restrictedGlobals],
      },
    },
    {
      name: 'aisdlc/config-and-tests',
      files: [...settings.configFiles, ...settings.testFiles],
      rules: {
        'no-restricted-properties': settings.restrictedProperties.length ? ['error', ...settings.restrictedProperties] : 'off',
      },
    },
  ];
}
