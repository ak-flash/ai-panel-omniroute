'use strict';

// ============================================================
// Persistence хранилища: sql.js (WASM SQLite без нативной сборки)
// и очередь записи на диск.
//
// База живёт в памяти процесса; каждое изменение экспортируется в
// файл атомарно (tmp + rename), параллельные записи сериализуются
// очередью: экспорт снимается в момент постановки в очередь, запись
// идёт строго по одной. flush() дожидается отложенной записи,
// close() закрывает базу после сброса.
// ============================================================

const fs = require('fs');
const path = require('path');

let sqlJsInit = null;
function loadSqlJs() {
  if (!sqlJsInit) sqlJsInit = require('sql.js')().then((m) => m);
  return sqlJsInit;
}

/** Открывает базу: из файла (если есть) или новую; in-memory — без файла. */
async function openDatabase({ dbPath, inMemory }) {
  const sql = await loadSqlJs();
  if (!inMemory && dbPath && fs.existsSync(dbPath)) {
    return { db: new sql.Database(fs.readFileSync(dbPath)), existed: true };
  }
  return { db: new sql.Database(), existed: false };
}

/** Очередь записи на диск. Для in-memory базы всё — no-op. */
function createPersistQueue({ db, dbPath, inMemory }) {
  let writeChain = Promise.resolve();
  let closed = false;

  /** Снимает копию базы и ставит атомарную запись в очередь. */
  function persist() {
    if (inMemory || !dbPath) return writeChain;
    const bytes = Buffer.from(db.export());
    writeChain = writeChain.then(() => {
      if (closed) return;
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      // Атомарная замена: во временный файл, затем rename
      const tmp = dbPath + '.tmp';
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, dbPath);
    });
    return writeChain;
  }

  /** Дожидается всех поставленных в очередь записей. */
  function flush() {
    return writeChain;
  }

  /** Сбрасывает очередь и закрывает базу. Повторный вызов безопасен. */
  async function close() {
    await flush();
    if (closed) return;
    closed = true;
    db.close();
  }

  return { persist, flush, close };
}

module.exports = { loadSqlJs, openDatabase, createPersistQueue };
