const MODEL_TEST_TIMEOUT_MS = 30000;

export function comboTestModelId(target) {
  if (target.modelId) return String(target.modelId);
  const raw = target._raw;
  if (raw && typeof raw === 'object') {
    if (raw.model) return String(raw.model);
    if (raw.modelId) return String(raw.modelId);
    if (raw.id) return String(raw.id);
  }
  return String(target.display || '');
}

/** Мини-запрос к конкретной модели через OmniRoute: max_tokens 1,
 * без кеша и памяти. Возвращает время ответа или кидает ошибку. */
export async function testComboModel(modelId) {
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch('/omniroute/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-OmniRoute-No-Cache': 'true' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
    });
  } catch (err) {
    const ms = Math.round(performance.now() - startedAt);
    const e = new Error(
      err && err.name === 'TimeoutError'
        ? 'таймаут ' + Math.round(MODEL_TEST_TIMEOUT_MS / 1000) + ' с'
        : 'нет ответа от OmniRoute'
    );
    e.ms = ms;
    throw e;
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* не JSON */
    }
    const detail =
      payload && ((payload.error && payload.error.message) || payload.message)
        ? payload.error.message || payload.message
        : 'HTTP ' + response.status;
    const e = new Error(detail);
    e.ms = Math.round(performance.now() - startedAt);
    throw e;
  }

  const latencyHeader = parseInt(response.headers.get('X-OmniRoute-Latency-Ms'), 10);
  const ms =
    Number.isFinite(latencyHeader) && latencyHeader > 0
      ? latencyHeader
      : Math.round(performance.now() - startedAt);
  try {
    await response.body.cancel();
  } catch {
    /* уже закрыт */
  }
  return { ms, model: response.headers.get('X-OmniRoute-Model') || modelId };
}
