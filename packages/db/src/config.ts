const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']);
const FORBIDDEN_QUERY_PARAMETERS = new Set(['hostaddr', 'service', 'passfile']);

export function assertLocalDatabaseUrl(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid PostgreSQL URL`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must use the postgres:// or postgresql:// protocol`);
  }

  const parameters = [...url.searchParams.entries()];
  const forbidden = parameters.find(([key]) =>
    FORBIDDEN_QUERY_PARAMETERS.has(key.toLowerCase()),
  );
  if (forbidden) {
    throw new Error(`${name} must not use the "${forbidden[0]}" connection parameter`);
  }

  const socketHosts = parameters
    .filter(([key]) => key.toLowerCase() === 'host')
    .map(([, host]) => host);
  if (socketHosts.length > 0) {
    if (socketHosts.some((host) => !host.startsWith('/'))) {
      throw new Error(
        `${name} must use a Unix socket path for the "host" parameter; remote hosts are refused`,
      );
    }
    return value;
  }

  if (url.hostname === '') {
    return value;
  }

  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(
      `${name} must point to a local PostgreSQL instance; refusing host "${url.hostname}"`,
    );
  }

  return value;
}

export function databaseUrlWithName(connectionString: string, databaseName: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) {
    throw new Error(`Invalid database name "${databaseName}"`);
  }

  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function redactDatabaseUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}
