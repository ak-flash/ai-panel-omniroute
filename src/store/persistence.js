'use strict';

// ============================================================
// Persistence хранилища: sql.js (WASM SQLite без нативной сборки)
// и очередь записи на диск.
//
// База живёт в памяти процесса; каждое изменение экспортируется в
// файл атомарно (уникальный tmp → fsync → rename), параллельные записи
// сериализуются очередью: экспорт снимается в момент постановки в
// очередь, запись идёт строго по одной. Ошибка записи не ломает
// очередь: база помечается «грязной», запись повторяется с паузой, а
// следующий успешный экспорт (он содержит все изменения) снимает флаг.
// flush() дожидается записи, close() закрывает базу после сброса.
// ============================================================

const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 30000, 60000];

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

/** Атомарная запись: права 0600, fsync до rename, tmp уникален для процесса. */
let tmpCounter = 0;
async function writeFileAtomic(filePath, bytes) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${++tmpCounter}.tmp`;
  let handle = null;
  try {
    handle = await fsp.open(tmp, 'w', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmp, filePath);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Очередь записи на диск. Для in-memory базы всё — no-op.
 * onError(err) — уведомление о сбое записи (лог); retryDelaysMs — паузы
 * повторов, последняя повторяется, пока запись не пройдёт.
 */
function createPersistQueue({
  db,
  dbPath,
  inMemory,
  onError = null,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
}) {
  let writeChain = Promise.resolve();
  let closing = false;
  let closed = false;
  let retryTimer = null;
  let retryAttempt = 0;
  const state = { dirty: false, lastError: null, lastErrorAt: 0, lastSuccessAt: 0, failures: 0 };

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    if (closing || retryTimer || !retryDelaysMs.length) return;
    const delay = retryDelaysMs[Math.min(retryAttempt, retryDelaysMs.length - 1)];
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (state.dirty && !closing) persist().catch(() => {});
    }, delay);
    retryTimer.unref();
  }

  function enqueue(bytes) {
    const run = writeChain.then(async () => {
      try {
        await writeFileAtomic(dbPath, bytes);
      } catch (err) {
        state.dirty = true;
        state.lastError = err;
        state.lastErrorAt = Date.now();
        state.failures += 1;
        if (onError) {
          try {
            onError(err);
          } catch {}
        }
        scheduleRetry();
        throw err;
      }
      state.dirty = false;
      state.lastError = null;
      state.lastSuccessAt = Date.now();
      retryAttempt = 0;
      clearRetry();
    });
    // Звено очереди не должно «запомнить» ошибку: следующие записи идут дальше
    writeChain = run.catch(() => {});
    return run;
  }

  /** Снимает копию базы и ставит атомарную запись в очередь.
   * Промис отклоняется, если не удалась именно эта запись. */
  function persist() {
    if (inMemory || !dbPath || closed) return Promise.resolve();
    return enqueue(Buffer.from(db.export()));
  }

  /** Дожидается всех записей; если изменения так и не легли на диск — ошибка. */
  async function flush() {
    await writeChain;
    if (state.dirty) throw state.lastError;
  }

  /** Сбрасывает очередь (с последней попыткой для «грязной» базы) и
   * закрывает базу. Повторный вызов безопасен. Если данные не удалось
   * сохранить — база всё равно закрывается, а промис отклоняется. */
  async function close() {
    if (closed) return;
    closing = true;
    clearRetry();
    await writeChain;
    if (state.dirty) await persist().catch(() => {});
    closed = true;
    db.close();
    if (state.dirty) throw state.lastError;
  }

  /** Состояние записи для /api/ready и логов (без путей и текста ошибок). */
  function status() {
    return {
      ok: !state.dirty,
      dirty: state.dirty,
      failures: state.failures,
      lastErrorAt: state.lastErrorAt || null,
      lastSuccessAt: state.lastSuccessAt || null,
    };
  }

  return { persist, flush, close, status };
}

module.exports = { loadSqlJs, openDatabase, createPersistQueue, writeFileAtomic };
