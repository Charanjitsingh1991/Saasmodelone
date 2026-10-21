import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { assertLocalDatabaseUrl } from './config.js';
import { listSqlFiles } from './migrate.js';

export type SeedOptions = {
  ownerUrl: string;
  seedDir?: string;
  log?: (event: Record<string, unknown>) => void;
};

function defaultSeedDir(): string {
  return process.env.SUITE_DB_DIR
    ? path.join(process.env.SUITE_DB_DIR, 'seed')
    : path.resolve(process.cwd(), 'suite', 'db', 'seed');
}

export async function seed(options: SeedOptions): Promise<string[]> {
  const ownerUrl = assertLocalDatabaseUrl('DB_OWNER_URL', options.ownerUrl);
  const seedDir = options.seedDir ?? defaultSeedDir();
  const log = options.log ?? (() => undefined);
  const files = await listSqlFiles(seedDir);

  if (files.length === 0) {
    throw new Error(`No seed files found in ${seedDir}`);
  }

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();

  try {
    for (const file of files) {
      const contents = await readFile(path.join(seedDir, file), 'utf8');
      try {
        await client.query(contents);
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Seed ${file} failed: ${message}`, { cause: error });
      }
      log({ event: 'seed.applied', file });
    }
    return files;
  } finally {
    await client.end();
  }
}
