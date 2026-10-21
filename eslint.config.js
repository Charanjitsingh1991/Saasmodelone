import path from 'node:path';
import process from 'node:process';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const workspacePackages = [
  '@saasmodels/api',
  '@saasmodels/contracts',
  '@saasmodels/db',
  '@saasmodels/testkit',
  '@saasmodels/web',
  '@saasmodels/worker',
];

const deepImportPatterns = [
  {
    group: ['@saasmodels/*/src/*', '**/packages/*/src/*', '**/apps/*/src/*'],
    message: 'Import a workspace package through its public entry point.',
  },
];

function boundaryRule(allowed) {
  const forbidden = workspacePackages
    .filter((name) => !allowed.includes(name))
    .flatMap((name) => [
      { group: [name, `${name}/*`], message: `${name} is not in this package's allowed import set.` },
    ]);

  return [
    'error',
    {
      patterns: [...forbidden, ...deepImportPatterns],
    },
  ];
}

const packageEscapeRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Reject relative imports that resolve outside the current workspace package.',
    },
    schema: [],
    messages: {
      escape:
        'Relative import "{{source}}" crosses the {{packageRoot}} package root. ' +
        'Import the package through its public entry point.',
    },
  },
  create(context) {
    const rawFilename = context.filename ?? context.getFilename?.();
    if (!rawFilename || rawFilename.startsWith('<')) {
      return {};
    }

    const absoluteFile = path.isAbsolute(rawFilename)
      ? rawFilename
      : path.resolve(process.cwd(), rawFilename);
    const relativeFile = path.relative(process.cwd(), absoluteFile).replaceAll('\\', '/');
    const match = /^(apps|packages)\/([^/]+)\//.exec(relativeFile);
    if (!match) {
      return {};
    }

    const packageRoot = path.resolve(process.cwd(), match[1], match[2]);
    const packageLabel = `${match[1]}/${match[2]}`;

    function check(node) {
      const source = node.source;
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') {
        return;
      }
      if (!source.value.startsWith('.')) {
        return;
      }

      const resolved = path.resolve(path.dirname(absoluteFile), source.value);
      const relativeToRoot = path.relative(packageRoot, resolved);
      const escapes =
        relativeToRoot === '..' ||
        relativeToRoot.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToRoot);
      if (!escapes) {
        return;
      }

      context.report({
        node: source,
        messageId: 'escape',
        data: { source: source.value, packageRoot: packageLabel },
      });
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

const localPlugin = {
  rules: {
    'no-relative-package-escape': packageEscapeRule,
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.tmp/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      local: localPlugin,
    },
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'off',
      'local/no-relative-package-escape': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'no-restricted-imports': boundaryRule(['@saasmodels/contracts']),
    },
  },
  {
    files: ['apps/api/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': boundaryRule(['@saasmodels/contracts', '@saasmodels/db']),
    },
  },
  {
    files: ['apps/worker/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': boundaryRule(['@saasmodels/contracts', '@saasmodels/db']),
    },
  },
  {
    files: ['apps/*/test/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': boundaryRule([
        '@saasmodels/contracts',
        '@saasmodels/db',
        '@saasmodels/testkit',
      ]),
    },
  },
  {
    files: ['packages/contracts/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': boundaryRule([]),
    },
  },
  {
    files: ['packages/db/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': boundaryRule(['@saasmodels/contracts']),
    },
  },
  {
    files: ['packages/testkit/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': boundaryRule(['@saasmodels/contracts', '@saasmodels/db']),
    },
  },
);
