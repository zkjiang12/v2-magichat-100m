import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pool = null;

export async function query(text, params = []) {
  return getPool().query(text, params);
}

function getPool() {
  if (pool) return pool;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: databaseUrl,
    // Dashboard sections fetch in parallel; 2 connections serializes them
    // again. But the upstream pooler caps ALL clients (both dashboard
    // instances + workers) at 15 session slots, so stay modest here.
    max: numberEnv('DATABASE_POOL_MAX', 4),
    // Keep connections warm across auto-refresh ticks so navigations don't
    // re-pay the SSL handshake.
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
    ssl: shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
  });
  return pool;
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
