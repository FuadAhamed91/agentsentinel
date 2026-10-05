// Local SQLite fallback built on sql.js (WebAssembly, no native build step).
// The database lives in memory and is written to SQLITE_PATH shortly after each write.
// sql.js runs on one connection, so every statement and transaction is serialized
// through a promise chain.

import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

function bindable(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

export async function openSqlite(file) {
  const SQL = await initSqlJs();
  const persistent = Boolean(file) && file !== ':memory:';
  let initial;
  if (persistent && fs.existsSync(file)) initial = fs.readFileSync(file);
  const db = new SQL.Database(initial);

  let chain = Promise.resolve();
  let dirty = false;
  let saveTimer = null;
  let closed = false;
  let saveFailures = 0;

  function exclusive(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  function exec(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params.map(bindable));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function writeFile() {
    if (!persistent || !dirty) return;
    dirty = false;
    const data = db.export();
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, file);
  }

  function markDirty() {
    if (!persistent || closed) return;
    dirty = true;
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        // The data stays in memory if the file cannot be written; log the first
        // failure and then every 100th so a read-only disk does not flood the log.
        exclusive(writeFile).catch((err) => {
          saveFailures += 1;
          if (saveFailures === 1 || saveFailures % 100 === 0) {
            console.error(`[db] sqlite save failed (${saveFailures}x): ${err.message}`);
          }
        });
      }, 2000);
      saveTimer.unref?.();
    }
  }

  const isRead = (sql) => /^\s*select\b/i.test(sql);

  return {
    kind: 'sqlite',
    forUpdate: '',
    query(sql, params) {
      return exclusive(() => {
        const rows = exec(sql, params);
        if (!isRead(sql)) markDirty();
        return rows;
      });
    },
    tx(fn) {
      return exclusive(async () => {
        exec('BEGIN');
        try {
          const handle = { query: async (sql, params) => exec(sql, params) };
          const result = await fn(handle);
          exec('COMMIT');
          markDirty();
          return result;
        } catch (err) {
          try { exec('ROLLBACK'); } catch { /* already rolled back */ }
          throw err;
        }
      });
    },
    async exec(sqlBatch) {
      return exclusive(() => {
        db.exec(sqlBatch);
        markDirty();
      });
    },
    async close() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      await exclusive(writeFile);
      closed = true;
      db.close();
    },
  };
}
