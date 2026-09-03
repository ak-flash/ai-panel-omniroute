/* ============================================================
   AI Panel — пороговые уведомления: чистая логика (RFC-0002).

   Без побочных эффектов: функции принимают текущие данные и пороги,
   возвращают массив срабатываний. Дедупликация и показ тостов
   делаются на стороне вызывающего (pages/index.js).

   Каждый результат имеет стабильный id вида "<provider>.<metric>.<value>"
   — вызывающий использует его, чтобы не повторять тост за сессию.

   Входные числа — терпимы: null/undefined/не-числа трактуются как
   "нет данных", порог не задан → функция возвращает [].
   ============================================================ */

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    // "12,5" → 12.5; "12.5" → 12.5; "" → null
    const s = v.trim().replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(spent, cap) {
  const s = toNumber(spent);
  const c = toNumber(cap);
  if (s == null || c == null || c <= 0) return null;
  return (s / c) * 100;
}

function inRangePct(v) {
  const n = toNumber(v);
  if (n == null) return null;
  if (n < 1 || n > 100) return null;
  return n;
}

function inRangeUsd(v) {
  const n = toNumber(v);
  if (n == null) return null;
  if (n < 0) return null;
  return n;
}

function windowByKind(usage, kind) {
  const list = (usage && Array.isArray(usage.windows)) ? usage.windows : [];
  return list.find((w) => w && w.kind === kind) || null;
}

/**
 * xKiro: пороги на процент использования в окнах.
 * thresholds = { short_window_pct, long_window_pct }
 * Возвращает массив { id, level, message } для сработавших порогов.
 */
export function evaluateXKiro(usage, thresholds) {
  if (!thresholds || typeof thresholds !== 'object') return [];
  const out = [];

  const short = inRangePct(thresholds.short_window_pct);
  if (short != null) {
    const w = windowByKind(usage, 'short');
    const p = w ? pct(w.spent_usd, w.cap_usd) : null;
    if (p != null && p >= short) {
      out.push({
        id: 'xkiro.short_window_pct.' + Math.round(short),
        level: p >= 95 ? 'error' : 'warn',
        message:
          'xKiro: использовано ' + Math.round(p) + '% короткого окна' +
          ' (порог ' + Math.round(short) + '%)',
      });
    }
  }

  const long = inRangePct(thresholds.long_window_pct);
  if (long != null) {
    const w = windowByKind(usage, 'long');
    const p = w ? pct(w.spent_usd, w.cap_usd) : null;
    if (p != null && p >= long) {
      out.push({
        id: 'xkiro.long_window_pct.' + Math.round(long),
        level: p >= 95 ? 'error' : 'warn',
        message:
          'xKiro: использовано ' + Math.round(p) + '% длинного окна' +
          ' (порог ' + Math.round(long) + '%)',
      });
    }
  }

  return out;
}

/**
 * AgentRouter: порог на остаток кошелька.
 * thresholds = { balance_below_usd }
 */
export function evaluateAgentRouter(usage, thresholds) {
  if (!thresholds || typeof thresholds !== 'object') return [];
  const below = inRangeUsd(thresholds.balance_below_usd);
  if (below == null) return [];
  const wallet = (usage && usage.wallet) || {};
  const balance = toNumber(wallet.balance_usd);
  if (balance == null) return [];
  if (balance < below) {
    return [{
      id: 'agentrouter.balance_below_usd.' + (below % 1 === 0 ? below : below.toFixed(2)),
      level: balance <= 0 ? 'error' : 'warn',
      message: 'AgentRouter: остаток $' + balance.toFixed(2) +
        ' ниже порога $' + below.toFixed(2),
    }];
  }
  return [];
}

/**
 * Antigravity: порог на минимальный remainingFraction среди моделей и окон.
 * thresholds = { remaining_below_pct } (1..100)
 */
export function evaluateAntigravity(quota, thresholds) {
  if (!thresholds || typeof thresholds !== 'object') return [];
  const below = inRangePct(thresholds.remaining_below_pct);
  if (below == null) return [];
  if (!quota || typeof quota !== 'object') return [];

  // Минимальный remainingFraction среди моделей
  let minR = null;
  const models = Array.isArray(quota.models) ? quota.models : [];
  for (const m of models) {
    if (!m) continue;
    const r = toNumber(m.remainingFraction);
    if (r == null) continue;
    if (minR == null || r < minR) minR = r;
  }
  // И среди окон
  const windows = Array.isArray(quota.windows) ? quota.windows : [];
  for (const w of windows) {
    if (!w) continue;
    const r = toNumber(w.remainingFraction);
    if (r == null) continue;
    if (minR == null || r < minR) minR = r;
  }
  if (minR == null) return [];
  const minPct = minR * 100;
  if (minPct < below) {
    return [{
      id: 'antigravity.remaining_below_pct.' + Math.round(below),
      level: minPct < 10 ? 'error' : 'warn',
      message: 'Antigravity: осталось ' + Math.round(minPct) +
        '% квоты (порог ' + Math.round(below) + '%)',
    }];
  }
  return [];
}

/**
 * Объединяет результаты по всем провайдерам.
 * data = { xkiro, agentrouter, antigravity }
 * thresholds = { xkiro, agentrouter, antigravity } — могут отсутствовать.
 */
export function evaluateAll(data, thresholds) {
  const t = thresholds || {};
  const d = data || {};
  return [
    ...evaluateXKiro(d.xkiro, t.xkiro),
    ...evaluateAgentRouter(d.agentrouter, t.agentrouter),
    ...evaluateAntigravity(d.antigravity, t.antigravity),
  ];
}
