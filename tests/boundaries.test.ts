import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';

const root = process.cwd();

function lintBoundaries(): { status: number | null; output: string } {
  const result = spawnSync('pnpm', ['lint:boundaries'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32',
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

const probes = [
  {
    name: 'TSX package import in web',
    file: path.join(root, 'apps', 'web', 'src', 'boundary-probe.tsx'),
    source: "import '@saasmodels/db';\n\nexport function BoundaryProbe() {\n  return null;\n}\n",
    expected: ['no-restricted-imports', '@saasmodels/db is not in this package'],
  },
  {
    name: 'relative API-to-web escape',
    file: path.join(root, 'apps', 'api', 'src', 'boundary-relative-probe.ts'),
    source: "import '../../web/src/index.js';\n\nexport const probe = true;\n",
    expected: ['no-relative-package-escape', 'crosses the apps/api package root'],
  },
];

test('lint:boundaries passes clean and rejects TSX and relative package escapes', async () => {
  const clean = lintBoundaries();
  expect(clean.status, clean.output).toBe(0);

  for (const probe of probes) {
    await writeFile(probe.file, probe.source, 'utf8');
    try {
      const violation = lintBoundaries();
      expect(violation.status, `${probe.name}\n${violation.output}`).not.toBe(0);
      for (const expected of probe.expected) {
        expect(violation.output).toContain(expected);
      }
    } finally {
      await rm(probe.file, { force: true });
    }
  }
});
