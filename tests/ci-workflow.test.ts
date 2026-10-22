import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// This is a contract test for the checked-in workflow. It proves the YAML
// expresses the intended policy; it is not evidence that GitHub executed it.
const workflowPath = path.resolve(process.cwd(), '.github', 'workflows', 'ci.yml');
const workflow = readFileSync(workflowPath, 'utf8');

describe('CI workflow contract', () => {
  test('is a read-only, push and pull-request workflow on a two-version Postgres matrix', () => {
    expect(workflow).toMatch(/^on:\s*$/m);
    expect(workflow).toMatch(/^\s{2}push:\s*$/m);
    expect(workflow).toMatch(/^\s{4}branches:\s*\[main\]\s*$/m);
    expect(workflow).toMatch(/^\s{2}pull_request:\s*$/m);
    expect(workflow).not.toContain('pull_request_target');

    expect(workflow).toMatch(/^permissions:\s*$/m);
    expect(workflow).toMatch(/^\s{2}contents:\s*read\s*$/m);
    expect(workflow).not.toMatch(/^\s{2}contents:\s*write/m);
    expect(workflow).not.toContain('write-all');

    expect(workflow).toMatch(/^concurrency:\s*$/m);
    expect(workflow).toMatch(/^\s{2}group:\s*\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.ref\s*\}\}\s*$/m);
    expect(workflow).toMatch(/^\s{2}cancel-in-progress:\s*true\s*$/m);
    expect(workflow).toMatch(/^\s{4}timeout-minutes:\s*20\s*$/m);
    expect(workflow).toMatch(/^\s{4}runs-on:\s*ubuntu-latest\s*$/m);

    expect(workflow).toMatch(/^\s{6}fail-fast:\s*false\s*$/m);
    expect(workflow).toMatch(/^\s{8}postgres:\s*\['16',\s*'17'\]\s*$/m);
    expect(workflow).toMatch(/^\s{8}image:\s*postgres:\$\{\{\s*matrix\.postgres\s*\}\}\s*$/m);
    expect(workflow).toContain('pg_isready');
    expect(workflow).toContain('5432:5432');
  });

  test('uses only the two reviewed actions with credentials disabled', () => {
    const uses = workflow
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('uses:'));
    expect(uses).toEqual(['uses: actions/checkout@v4', 'uses: actions/setup-node@v4']);

    expect(workflow).toMatch(/^\s{10}persist-credentials:\s*false\s*$/m);
    expect(workflow).toMatch(/^\s{10}node-version:\s*22\s*$/m);
    expect(workflow).toContain("COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'");
    expect(workflow).toContain('corepack prepare pnpm@10.18.3 --activate');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('continue-on-error');
  });

  test('uses only localhost CI database credentials and runs every required command in order', () => {
    const urls = workflow
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(?:TEST_DB_|DB_)[A-Z]+_URL:/.test(line));
    expect(urls).toHaveLength(8);
    for (const url of urls) {
      expect(url).toContain('@localhost:5432/');
    }

    expect(workflow).toMatch(/SAAS_OWNER_PASSWORD:\s*ci-owner-password/);
    expect(workflow).toMatch(/SAAS_RUNTIME_PASSWORD:\s*ci-runtime-password/);
    expect(workflow).toMatch(/SAAS_AUTH_PASSWORD:\s*ci-auth-password/);

    const runLines = [...workflow.matchAll(/^\s+run:\s+(?!\|)(.+)$/gm)].map((match) =>
      match[1]?.trim(),
    );
    expect(runLines).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm secret-scan',
      'pnpm audit --prod --audit-level high',
      'pnpm typecheck',
      'pnpm lint',
      'pnpm lint:boundaries',
      'pnpm db:bootstrap',
      'pnpm db:migrate',
      'pnpm db:migrate',
      'pnpm db:seed',
      'pnpm db:seed',
      'pnpm test',
      'pnpm exec playwright install --with-deps chromium',
      'pnpm test:e2e',
    ]);
  });
});
