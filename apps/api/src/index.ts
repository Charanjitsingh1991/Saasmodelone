import { pathToFileURL } from 'node:url';
import { assertLocalDatabaseUrl, createRuntimePool } from '@saasmodels/db';
import { createServer } from './server.js';

async function start(): Promise<void> {
  const connectionString = assertLocalDatabaseUrl(
    'DB_RUNTIME_URL',
    process.env.DB_RUNTIME_URL,
  );
  const pool = createRuntimePool(connectionString);
  const app = createServer({
    pool,
    authenticate: async () => null,
    logger: true,
  });

  app.log.warn(
    'Identity is not configured: every protected route returns 401 until an authenticator is wired.',
  );

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
