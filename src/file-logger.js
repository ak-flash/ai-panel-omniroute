'use strict';

// ============================================================
// Файловый лог приложения.
//
// Каждая запись — одна строка с ISO-таймстампом и уровнем —
// добавляется в файл и дублируется в консоль: при локальном
// запуске диагноз виден сразу, а история сохраняется между
// перезапусками (в отличие от консоли PM2/фона).
//
// Ошибки записи не роняют сервер: после первой неудачи файл
// больше не трогается, остаётся только консоль. Ротация простая:
// при превышении maxBytes файл переименовывается в <имя>.old
// (старый .old перезаписывается). Файл создаётся с правами 0600,
// каталог — 0700: в логе бывают адреса upstream и диагностика.

// ============================================================

const fs = require('fs');
const path = require('path');

// Общий лимит ротации для всех логгеров процесса (пишут в один файл)
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Создаёт файловый логгер.
 *
 * Возвращает обратно совместимую функцию log(...args) (уровень warn,
 * формат «таймстамп сообщение») с дополнительными методами
 * info/warn/error, которые добавляют уровень в запись, и
 * infoFile/warnFile/errorFile — только в файл, без консоли.
 *
 * opts:
 *   file     — путь к лог-файлу (пустой/undefined — только консоль)
 *   maxBytes — порог ротации (по умолчанию 50 МБ)
 *   mirror   — куда дублировать строки (по умолчанию console)
 *
 * @param {{file?: string, maxBytes?: number, mirror?: *}} [opts]
 */
function createFileLogger({ file, maxBytes = DEFAULT_MAX_BYTES, mirror = console } = {}) {
  let broken = false;

  function rotateIfNeeded() {
    if (!file) return;
    try {
      if (fs.statSync(file).size <= maxBytes) return;
      fs.renameSync(file, file + '.old');
    } catch {}
  }

  // Форматирование аргументов в одну строку — только для mirror (console)
  /** @param {unknown[]} args @returns {string} */
  function fmtArgs(args) {
    return args
      .map(a => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object' && a !== null) {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ')
      .replace(/\r?\n/g, ' ');
  }

  // Сериализация Error для JSON-записи (рекурсивная по cause)
  /** @param {unknown} err @returns {unknown} */
  function serializeError(err) {
    if (!(err instanceof Error)) return err;
    return {
      message: err.message,
      stack: err.stack,
      ...(err.cause ? { cause: serializeError(err.cause) } : {}),
    };
  }

  const SECRET_KEY_RE = /token|secret|key|authorization|cookie/i;

  // Строит JSON-запись из level-строки и массива аргументов.
  // Первый строковый аргумент — message; остальное мержится как поля.
  /** @param {string} level @param {unknown[]} args @returns {Record<string, unknown>} */
  function buildRecord(level, args) {
    /** @type {Record<string, unknown>} */
    const record = { time: new Date().toISOString(), level };
    let messageSet = false;
    for (const a of args) {
      if (!messageSet && typeof a === 'string') {
        record.message = a.replace(/\r?\n/g, ' ');
        messageSet = true;
      } else if (a instanceof Error) {
        // Если нет message — использовать err.message как message
        if (!messageSet) {
          record.message = a.message;
          messageSet = true;
        }
        record.error = serializeError(a);
      } else if (typeof a === 'object' && a !== null) {
        for (const [k, v] of Object.entries(a)) {
          if (SECRET_KEY_RE.test(k)) continue;
          record[k] = typeof v === 'number' || typeof v === 'boolean' ? v : v;
        }
      } else if (typeof a === 'number' || typeof a === 'boolean') {
        if (!messageSet) {
          record.message = String(a);
          messageSet = true;
        }
      }
    }
    return record;
  }

  // Запись JSON Lines в файл (без вывода в консоль). levelTag — '[INFO]'/'[WARN]'/''.
  /** @param {string} levelTag @param {string} body @param {Record<string, unknown>|null} record @returns {void} */
  function writeToFile(levelTag, body, record) {
    if (broken || !file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      rotateIfNeeded();
      // record присутствует при вызове из structured-уровней
      const line = record
        ? JSON.stringify(record)
        : JSON.stringify({ time: new Date().toISOString(), level: 'log', message: body });
      fs.appendFileSync(file, line + '\n', { mode: 0o600 });
    } catch {
      broken = true;
    }
  }

  // Запись в файл + дублирование в mirror (console)
  /** @param {string} levelTag @param {unknown[]} args @returns {void} */
  function writeLine(levelTag, args) {
    const body = fmtArgs(args);
    const line = (levelTag ? levelTag + ' ' : '') + body;
    if (mirror) {
      const fn = typeof mirror.warn === 'function' ? mirror.warn : null;
      if (fn) fn.call(mirror, line);
    }
    writeToFile(levelTag, body, null);
  }

  /** @param {...unknown} args */
  function log(...args) {
    writeLine('', args);
  }

  // Structured-уровни: добавляют тег уровня и дублируют в mirror.
  // .infoFile/.warnFile/.errorFile — пишут ТОЛЬКО в файл (без консоли).
  /** @type {Record<string, string>} */
  const LEVEL_TAG = { info: '[INFO]', warn: '[WARN]', error: '[ERROR]' };
  for (const level of Object.keys(LEVEL_TAG)) {
    const tag = LEVEL_TAG[level];
    /** @type {(...args: unknown[]) => void} */
    const write = (...args) => {
      const body = fmtArgs(args);
      if (mirror) {
        const fn = typeof mirror[level] === 'function' ? mirror[level] : mirror.warn;
        if (typeof fn === 'function') fn.call(mirror, tag + ' ' + body);
      }
      writeToFile(tag, body, buildRecord(level, args));
    };
    /** @type {(...args: unknown[]) => void} */
    const writeFileOnly = (...args) => writeToFile(tag, fmtArgs(args), buildRecord(level, args));
    /** @type {any} */ (log)[level] = write;
    /** @type {any} */ (log)[level + 'File'] = writeFileOnly;
  }
  // Alias: log.log — сама функция (для случаев, когда ожидают свойство)
  log.log = log;

  return log;
}

/**
 * Приводит логгер к одному интерфейсу: функция log(...args) уровня warn
 * с методами info/warn/error. Принимает файловый логгер, любую функцию
 * (в т.ч. связанную через bind — у неё нет методов), объект с методами
 * (console) или ничего — тогда пишет в console.
 */
/**
 * @typedef {((...args: unknown[]) => void) & Record<string, (...args: unknown[]) => void>} LogFn
 */

/** @param {unknown} [logger] @returns {LogFn} */
function normalizeLog(logger) {
  /** @type {any} */
  const target = logger || console;
  /** @param {string} level */
  const method = level =>
    typeof target[level] === 'function'
      ? /** @param {...unknown} args */ (...args) => target[level](...args)
      : null;
  const base =
    typeof target === 'function'
      ? /** @param {...unknown} args */ (...args) => target(...args)
      : method('warn') || /** @param {...unknown} args */ ((...args) => console.warn(...args));
  const log = /** @type {any} */ (/** @param {...unknown} args */ (...args) => base(...args));
  log.info = method('info') || base;
  log.warn = method('warn') || base;
  log.error = method('error') || base;
  return log;
}

module.exports = { createFileLogger, normalizeLog, DEFAULT_MAX_BYTES };
