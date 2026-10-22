import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  formatFinding,
  isBinary,
  scanContent,
  scanPath,
  scanRepository,
} from '../scripts/secret-scan.js';

function fake(...parts: string[]): string {
  return parts.join('');
}

const FAKE_AWS_KEY = fake('AK', 'IA', 'ABCDEFGHIJKLMNOP');
const FAKE_GITHUB_TOKEN = fake('gh', 'p_', 'a'.repeat(36));
const FAKE_SLACK_TOKEN = fake('xox', 'b-', '1234567890');
const FAKE_STRIPE_KEY = fake('sk_', 'live_', 'a'.repeat(24));
const FAKE_GOOGLE_KEY = fake('AI', 'za', 'a'.repeat(35));
const FAKE_SESSION_TOKEN = fake('saas_session', '=', 'a'.repeat(64));
const FAKE_PRIVATE_KEY = fake('-----BEGIN ', 'RSA PRIVATE KEY-----');

describe('secret scan rules', () => {
  test('detects every content rule without exposing the matched value', () => {
    const cases = [
      ['private-key-block', FAKE_PRIVATE_KEY],
      ['aws-access-key-id', FAKE_AWS_KEY],
      ['github-token', FAKE_GITHUB_TOKEN],
      ['slack-token', FAKE_SLACK_TOKEN],
      ['stripe-live-key', FAKE_STRIPE_KEY],
      ['google-api-key', FAKE_GOOGLE_KEY],
      ['session-cookie-token', FAKE_SESSION_TOKEN],
    ] as const;

    for (const [rule, value] of cases) {
      const findings = scanContent('fixtures/token.txt', value);
      expect(findings).toEqual([{ path: 'fixtures/token.txt', line: 1, rule }]);
      expect(formatFinding(findings[0]!)).toBe(`fixtures/token.txt:1 ${rule}`);
      expect(formatFinding(findings[0]!)).not.toContain(value);
      expect(JSON.stringify(findings)).not.toContain(value);
    }
  });

  test('does not flag benign local configuration, placeholders or integrity hashes', () => {
    const content = [
      'DB_OWNER_URL=postgres://saas_owner:local-owner-password@localhost:54329/saasmodels',
      'SAAS_AUTH_PASSWORD=local-auth-password',
      `checksum=${'a'.repeat(64)}`,
      'AKIA is only a prefix here',
      'github_pat_short',
      'saas_session is the cookie name',
      '-----BEGIN CERTIFICATE-----',
    ].join('\n');
    expect(scanContent('fixtures/benign.txt', content)).toEqual([]);
  });

  test('detects tracked sensitive paths and allows .env.example', () => {
    expect(scanPath('config/.env')).toEqual([
      { path: 'config/.env', line: 1, rule: 'tracked-env-file' },
    ]);
    expect(scanPath('.env.example')).toEqual([]);
    expect(scanPath('certs/server.pem')).toEqual([
      { path: 'certs/server.pem', line: 1, rule: 'private-key-file' },
    ]);
    expect(scanPath('certs/client.p12')).toEqual([
      { path: 'certs/client.p12', line: 1, rule: 'private-key-file' },
    ]);
    expect(scanPath('keys/id_rsa')).toEqual([
      { path: 'keys/id_rsa', line: 1, rule: 'ssh-private-key-file' },
    ]);
    expect(scanPath('keys/id_ed25519')).toEqual([
      { path: 'keys/id_ed25519', line: 1, rule: 'ssh-private-key-file' },
    ]);
    expect(scanPath('keys/id_rsa.pub')).toEqual([]);
  });

  test('classifies binary content and leaves the repository clean', () => {
    expect(isBinary(Buffer.from('plain text'))).toBe(false);
    expect(isBinary(Buffer.from([0x74, 0x00, 0x78]))).toBe(true);
    expect(scanRepository(process.cwd())).toEqual([]);
  });

  test('scans tracked and untracked non-ignored regular files, skips ignored and binary content, and reports paths without values', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'saasmodels-secret-scan-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: directory });
      await writeFile(path.join(directory, '.gitignore'), 'ignored.txt\n');
      await writeFile(path.join(directory, 'leak.txt'), `credential=${FAKE_AWS_KEY}\n`);
      await writeFile(path.join(directory, '.env'), 'DO_NOT_TRACK_ME\n');
      await writeFile(
        path.join(directory, 'binary.bin'),
        Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(FAKE_STRIPE_KEY)]),
      );
      await writeFile(path.join(directory, 'ignored.txt'), `credential=${FAKE_GITHUB_TOKEN}\n`);
      execFileSync('git', ['add', '.gitignore', '.env', 'leak.txt', 'binary.bin'], {
        cwd: directory,
      });
      await writeFile(path.join(directory, 'untracked.txt'), `credential=${FAKE_SLACK_TOKEN}\n`);

      const tracked = execFileSync('git', ['ls-files', '-z'], {
        cwd: directory,
        encoding: 'utf8',
      });
      expect(tracked.split('\0')).not.toContain('untracked.txt');

      const findings = scanRepository(directory);
      expect(findings).toEqual([
        { path: '.env', line: 1, rule: 'tracked-env-file' },
        { path: 'leak.txt', line: 1, rule: 'aws-access-key-id' },
        { path: 'untracked.txt', line: 1, rule: 'slack-token' },
      ]);
      for (const token of [FAKE_AWS_KEY, FAKE_GITHUB_TOKEN, FAKE_SLACK_TOKEN]) {
        expect(JSON.stringify(findings)).not.toContain(token);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('skips tracked symlinks', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const directory = await mkdtemp(path.join(tmpdir(), 'saasmodels-secret-scan-link-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: directory });
      await writeFile(path.join(directory, 'real.txt'), `credential=${FAKE_AWS_KEY}\n`);
      await symlink('real.txt', path.join(directory, 'link.txt'));
      execFileSync('git', ['add', '.'], { cwd: directory });

      expect(scanRepository(directory)).toEqual([
        { path: 'real.txt', line: 1, rule: 'aws-access-key-id' },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
