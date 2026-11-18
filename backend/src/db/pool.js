'use strict';
const { Pool, types } = require('pg');
const config = require('../config');

// BIGINT (int8) -> Number. Valores em centavos cabem com folga em Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// DATE -> string 'YYYY-MM-DD' (evita deslocamento de fuso)
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL_MAX || 10) });

/** Executa `fn(client)` dentro de uma transação. Faz ROLLBACK em qualquer erro. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query: (text, params) => pool.query(text, params), withTransaction };
