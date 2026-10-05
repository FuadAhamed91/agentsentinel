// Production database: Postgres through DATABASE_URL (pure JS driver, no native build).
// SQL in this codebase uses "?" placeholders; they are rewritten to $1, $2, ... here.

import pg from 'pg';

// int8 (COUNT, BIGINT, BIGSERIAL) arrives as a string by default. Values here
// are millisecond timestamps and row ids, well inside Number's safe range.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

function placeholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function openPostgres(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30000 });
  pool.on('error', (err) => console.error('[db] idle postgres client error:', err.message));

  // Fail fast at startup when the URL is wrong.
  await pool.query('SELECT 1');

  return {
    kind: 'postgres',
    forUpdate: ' FOR UPDATE',
    async query(sql, params = []) {
      const res = await pool.query(placeholders(sql), params);
      return res.rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const handle = {
          query: async (sql, params = []) => (await client.query(placeholders(sql), params)).rows,
        };
        const result = await fn(handle);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sqlBatch) {
      await pool.query(sqlBatch);
    },
    async close() {
      await pool.end();
    },
  };
}
