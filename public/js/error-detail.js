/** Разбор ошибки сетевого запроса в читаемый текст для статусной строки. */

/**
 * Собирает сообщение об ошибке: текст, статус и тело ответа, если они есть.
 *
 * @param {unknown} err  ошибка или Response-подобный объект
 * @returns {string}
 */
export function formatErrorDetail(err) {
  let msg = err && err.message ? err.message : String(err);
  // Пытаемся извлечь статус и тело, если есть Response-подобный объект
  if (err && err.status !== undefined) {
    const statusText = err.statusText ? ' ' + err.statusText : '';
    msg += ' (статус: ' + err.status + statusText + ')';
  }
  if (err && err.body) {
    const bodyStr = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
    msg += ' Тело: ' + bodyStr;
  }
  // Если есть response и он ещё не обработан
  if (err && err.response && typeof err.response === 'object') {
    const resp = err.response;
    if (resp.status !== undefined) {
      const statusText = resp.statusText ? ' ' + resp.statusText : '';
      msg += ' (статус ответа: ' + resp.status + statusText + ')';
    }
    // Если тело не было извлечено, но есть promise, не пытаемся его читать здесь
  }
  return msg;
}
