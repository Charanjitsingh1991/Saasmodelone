import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type SecretFinding = {
  path: string;
  line: number;
  rule: string;
};

type ContentRule = {
  rule: string;
  pattern: RegExp;
};

const CONTENT_RULES: readonly ContentRule[] = [
  {
    rule: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { rule: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    rule: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  { rule: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'stripe-live-key', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { rule: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'session-cookie-token', pattern: /\bsaas_session=[0-9a-fA-F]{64}\b/ },
];

// Path findings identify the whole file, so they use line 1.
export function scanPath(relativePath: string): SecretFinding[] {
  const normalized = relativePath.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).toLowerCase();
  const findings: SecretFinding[] = [];

  if (basename === '.env') {
    findings.push({ path: normalized, line: 1, rule: 'tracked-env-file' });
  }
  if (/\.(pem|key|p12|pfx)$/.test(basename)) {
    findings.push({ path: normalized, line: 1, rule: 'private-key-file' });
  }
  if (basename === 'id_rsa' || basename === 'id_ed25519') {
    findings.push({ path: normalized, line: 1, rule: 'ssh-private-key-file' });
  }

  return findings;
}

export function scanContent(relativePath: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r\n|\n|\r/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const rule of CONTENT_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ path: relativePath, line: index + 1, rule: rule.rule });
      }
    }
  }

  return findings;
}

export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

export function scanRepository(root: string = process.cwd()): SecretFinding[] {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = output.split('\0').filter((file) => file.length > 0);
  const findings: SecretFinding[] = [];

  for (const file of files) {
    const fullPath = path.join(root, file);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }

    // Symlinks and other non-regular tracked paths are not scanned.
    if (!stat.isFile()) {
      continue;
    }

    findings.push(...scanPath(file));

    const buffer = readFileSync(fullPath);
    if (isBinary(buffer)) {
      continue;
    }
    findings.push(...scanContent(file, buffer.toString('utf8')));
  }

  return findings.sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) {
      return byPath;
    }
    const byLine = left.line - right.line;
    return byLine !== 0 ? byLine : left.rule.localeCompare(right.rule);
  });
}

export function formatFinding(finding: SecretFinding): string {
  return `${finding.path}:${finding.line} ${finding.rule}`;
}

function main(): void {
  try {
    const findings = scanRepository(process.cwd());
    for (const finding of findings) {
      console.log(formatFinding(finding));
    }
    if (findings.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'scan failed';
    console.error(`secret-scan: ${message}`);
    process.exitCode = 2;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  main();
}
