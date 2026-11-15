import { SqlError, ErrorCodes } from '../../errors.js';

/**
 * Resolve connection settings from the options accepted by `connect()`.
 *
 * A URL (`postgres://user:pass@host:5432/db?sslmode=require`) supplies the
 * defaults, explicit `connectionOptions` override individual fields, and the
 * top-level shortcuts (`host`, `user`, ...) win over both.
 *
 * @param {object} options options passed to `connect()`
 * @param {{ port: number, user?: string, ssl?: string }} defaults
 */
export function resolveConnection(options = {}, defaults = {}) {
  /** @type {Record<string, any>} */
  const settings = { ...(options.connectionOptions || {}) };

  const url = options.connectionString ?? options.url ?? settings.connectionString ?? settings.url;
  if (url) {
    const parsed = parseUrl(url);
    const fromUrl = {
      host: parsed.hostname ? decodeURIComponent(parsed.hostname) : undefined,
      port: parsed.port ? Number(parsed.port) : undefined,
      user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      database:
        parsed.pathname && parsed.pathname.length > 1
          ? decodeURIComponent(parsed.pathname.slice(1))
          : undefined
    };
    for (const [key, value] of Object.entries(fromUrl)) {
      if (value !== undefined && settings[key] === undefined) settings[key] = value;
    }
    for (const [key, value] of parsed.searchParams) {
      if (settings[key] === undefined) settings[key] = value;
    }
  }

  for (const key of ['host', 'port', 'user', 'password', 'database', 'ssl', 'sslmode']) {
    if (options[key] !== undefined) settings[key] = options[key];
  }

  const port = Number(settings.port ?? defaults.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SqlError(ErrorCodes.DRIVER_ERROR, `Invalid database port: ${settings.port}`);
  }

  return {
    ...settings,
    host: settings.host || 'localhost',
    port,
    user: settings.user ?? defaults.user,
    password: settings.password ?? '',
    database: settings.database,
    sslmode: settings.sslmode ?? (settings.ssl === undefined ? defaults.ssl : settings.ssl),
    connectTimeout: Number(settings.connectTimeout ?? settings.connectionTimeoutMillis ?? 10000)
  };
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    throw new SqlError(
      ErrorCodes.DRIVER_ERROR,
      `Invalid connection string: ${String(url).replace(/\/\/[^@]*@/, '//')}`
    );
  }
}

/** Parse `sslmode` into a TLS policy. */
export function tlsPolicy(mode) {
  if (mode === undefined || mode === null || mode === false || mode === 'disable') return 'disable';
  if (mode === true || mode === 'require' || mode === 'required') return 'require';
  if (mode === 'prefer') return 'prefer';
  if (mode === 'verify-ca' || mode === 'verify-full' || mode === 'verify') return 'verify';
  if (typeof mode === 'object') return 'verify';
  return 'require';
}

/** TLS options for `node:tls`. */
export function tlsOptions(settings, policy) {
  const ssl = typeof settings.ssl === 'object' && settings.ssl !== null ? settings.ssl : {};
  return {
    servername: settings.host,
    rejectUnauthorized: policy === 'verify' ? ssl.rejectUnauthorized !== false : false,
    ...ssl
  };
}
