'use strict';

// ============================================================
// Криптография хранилища: AES-256-GCM для каждого значения.
//
// Формат записи (v1) сохранён байт-в-байт с первой версией store,
// чтобы существующие базы data/store.db открывались без миграции:
//   v1:<iv base64>:<auth-tag base64>:<ciphertext base64>
//
// Функции принимают master-ключ явно (вышестоящий слой сам решает,
// откуда он взят) и не бросают исключений: decryptValue возвращает
// размеченный результат, чтобы отличать неверный ключ (не сошлась
// подпись GCM) от повреждённой записи (битый формат).
// ============================================================

const crypto = require('crypto');

const FORMAT_VERSION = 'v1';

/** Ошибка хранилища: code позволяет обработчику различать случаи
 * (wrong_key, corrupted, unknown_key, store_closed, bad_master_key). */
class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** Случайный master-ключ (32 байта) в hex. */
function generateMasterKey() {
  return crypto.randomBytes(32).toString('hex');
}

/** Шифрует строку под данным master-ключом. */
function encryptValue(masterKeyHex, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(masterKeyHex, 'hex'),
    iv,
  );
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    FORMAT_VERSION + ':' +
    iv.toString('base64') + ':' +
    tag.toString('base64') + ':' +
    enc.toString('base64')
  );
}

/**
 * Расшифровывает запись. Возвращает:
 *   { ok: true, value }             — успех;
 *   { ok: false, reason: 'auth' }   — подпись не сошлась (обычно неверный ключ);
 *   { ok: false, reason: 'format' } — запись не в формате v1 (повреждение).
 */
function decryptValue(masterKeyHex, payload) {
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    return { ok: false, reason: 'format' };
  }
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(masterKeyHex, 'hex'),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return { ok: true, value: dec.toString('utf8') };
  } catch {
    return { ok: false, reason: 'auth' };
  }
}

module.exports = {
  StoreError,
  generateMasterKey,
  encryptValue,
  decryptValue,
  FORMAT_VERSION,
};
