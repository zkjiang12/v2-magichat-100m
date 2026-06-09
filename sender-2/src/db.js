import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function createPool({ databaseUrl }) {
  const { Pool } = require('pg');
  return new Pool({
    connectionString: databaseUrl,
    max: numberEnv('DATABASE_POOL_MAX', 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
  });
}

export async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await callback(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function shouldUseSsl(databaseUrl) {
  return /^postgres(?:ql)?:\/\//.test(String(databaseUrl || '')) &&
    !String(databaseUrl).includes('localhost') &&
    !String(databaseUrl).includes('127.0.0.1');
}

function numberEnv(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}
