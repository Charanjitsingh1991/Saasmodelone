import { pathToFileURL } from 'node:url';
import {
  assertLocalDatabaseUrl,
  createAuthPool,
  createRuntimePool,
} from '@saasmodels/db';
import { createServer } from './server.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readAppOrigin(): string {
  const raw = required('APP_ORIGIN');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('APP_ORIGIN must be an absolute http(s) origin');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== raw) {
    throw new Error('APP_ORIGIN must be an http(s) origin without a path');
  }
  return raw;
}

function readSecureCookies(): boolean {
  const raw = process.env.COOKIE_SECURE?.trim();
  if (!raw) {
    return process.env.NODE_ENV === 'production';
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error('COOKIE_SECURE must be true or false');
}

async function start(): Promise<void> {
  const runtimeUrl = assertLocalDatabaseUrl('DB_RUNTIME_URL', process.env.DB_RUNTIME_URL);
  const authUrl = assertLocalDatabaseUrl('DB_AUTH_URL', process.env.DB_AUTH_URL);
  const appOrigin = readAppOrigin();
  const secureCookies = readSecureCookies();

  const pool = createRuntimePool(runtimeUrl);
  const authPool = createAuthPool(authUrl);
  const app = createServer({
    pool,
    authPool,
    appOrigin,
    secureCookies,
    logger: true,
  });

  const port = Number(process.env.API_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT must be a valid TCP port');
  }

  await app.listen({ host: '127.0.0.1', port });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await authPool.end();
    await pool.end();
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await start();
}
