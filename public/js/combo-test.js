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

function hasUsableContent(content) {
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some(part => {
    if (typeof part === 'string') return part.trim() !== '';
    if (!part || typeof part !== 'object') return false;
    return (
      (part.type === 'text' || part.type === 'output_text') &&
      typeof part.text === 'string' &&
      part.text.trim() !== ''
    );
  });
}

/** Мини-запрос к конкретной модели через OmniRoute: запас токенов
 * покрывает reasoning и видимый ответ. Возвращает время ответа или кидает ошибку. */
export async function testComboModel(modelId) {
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch('/omniroute/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-OmniRoute-No-Cache': 'true' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
        max_tokens: 4096,
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

  let payload;
  try {
    payload = await response.json();
  } catch {
    const e = new Error('OmniRoute вернул некорректный JSON');
    e.ms = Math.round(performance.now() - startedAt);
    throw e;
  }
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!choice || !choice.message || !hasUsableContent(choice.message.content)) {
    const e = new Error('модель вернула пустой ответ');
    e.ms = Math.round(performance.now() - startedAt);
    throw e;
  }

  const latencyHeader = parseInt(response.headers.get('X-OmniRoute-Latency-Ms'), 10);
  const ms =
    Number.isFinite(latencyHeader) && latencyHeader > 0
      ? latencyHeader
      : Math.round(performance.now() - startedAt);
  return { ms, model: response.headers.get('X-OmniRoute-Model') || modelId };
}
