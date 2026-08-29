'use strict';

// ============================================================
// Ежедневный снимок баланса AgentRouter.
//
// Раз в сутки (как только наступили новые сутки, ~00:00) берём
// баланс ключом из хранилища и сохраняем его как стартовый баланс
// дня. Карточка вычитает из него текущий баланс и показывает
// «потребление за сутки». Храним только последний снимок — при
// смене суток он перезаписывается.
//
// Зависимости приходят параметрами (store через getStore, адаптер
// провайдера, поля хранилища) — модуль не трогает env и fs.
// ============================================================

/** Ключ снимка в хранилище: JSON { date: 'YYYY-MM-DD', balance_usd }. */
const AGENTROUTER_DAY_BALANCE_KEY = 'agentrouterDayBalance';

function createAgentRouterTracker({
  getStore,
  provider,
  storeKey,
  userField,
  balanceKey = AGENTROUTER_DAY_BALANCE_KEY,
  now = () => new Date(),
}) {
  let interval = null;

  const todayStr = () => {
    const d = now();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + String(d.getDate()).padStart(2, '0');
  };

  /** Разовый снимок: баланс ключом из хранилища → JSON в хранилище. */
  async function snapshotDayBalance() {
    try {
      const s = await (await getStore()).snapshot();
      const key = String(s[storeKey] || '').trim();
      const uid = String(s[userField] || '').trim();
      if (!key || !uid || !provider) return;
      const result = await provider.getUsage(key, uid);
      if (result.status !== 200) return;
      const bal = Number((result.data && result.data.wallet || {}).balance_usd);
      if (!Number.isFinite(bal)) return;
      await (await getStore()).set(
        balanceKey,
        JSON.stringify({ date: todayStr(), balance_usd: bal }),
      );
    } catch {}
  }

  /**
   * Планировщик: раз в минуту проверяет смену суток; снимок за сегодня
   * делается один раз. Реальный снимок берётся в 00:00; перезапуск
   * сервера днём не переснимает баланс.
   */
  function start() {
    if (interval) return;
    let busy = false;
    interval = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await (await getStore()).snapshot();
        const saved = s[balanceKey];
        let savedDate = null;
        if (saved) { try { savedDate = JSON.parse(saved).date; } catch {} }
        if (savedDate !== todayStr()) await snapshotDayBalance();
      } catch {} finally {
        busy = false;
      }
    }, 60000);
    snapshotDayBalance();
  }

  /** Останавливает планировщик (lifecycle API, идемпотентен). */
  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  /** Стартовый баланс для карточки (только если он за сегодня). */
  async function getDayBalanceUsd() {
    try {
      const s = await (await getStore()).snapshot();
      const saved = s[balanceKey];
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      if (parsed.date !== todayStr()) return null;
      const bal = Number(parsed.balance_usd);
      return Number.isFinite(bal) ? bal : null;
    } catch {
      return null;
    }
  }

  return { snapshotDayBalance, start, stop, getDayBalanceUsd };
}

module.exports = { createAgentRouterTracker, AGENTROUTER_DAY_BALANCE_KEY };
