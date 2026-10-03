'use strict';

// ============================================================
// Ежедневный снимок баланса AgentRouter.
//
// Раз в сутки (как только наступили новые сутки по UTC — той же
// границей считают «сегодня» OpenRouter и Experiential) берём баланс
// ключом из хранилища и сохраняем его как стартовый баланс
// дня. Карточка вычитает из него текущий баланс и показывает
// «потребление за сутки». Храним только последний снимок — при
// смене суток он перезаписывается. Перезапуск сервера днём снимок
// не переснимает.
//
// Зависимости приходят параметрами (store через getStore, адаптер
// провайдера, поля хранилища, часы now) — модуль не трогает env и fs.
// ============================================================

/** Ключ снимка в хранилище: JSON { date: 'YYYY-MM-DD', balance_usd }. */
const AGENTROUTER_DAY_BALANCE_KEY = 'agentrouterDayBalance';

function createAgentRouterTracker({
  getStore,
  provider,
  getCredential,
  storeKey,
  userField,
  balanceKey = AGENTROUTER_DAY_BALANCE_KEY,
  now = () => new Date(),
  intervalMs = 60000,
  logger = null,
}) {
  let interval = null;
  // Логирование опционально: без logger (тесты) события не пишутся
  const warnEvent = logger
    ? (event, fields = {}) => {
        try {
          const w = typeof logger.warn === 'function' ? logger.warn : logger;
          w(`[tracker] снимок баланса: сбой`, { event, ...fields });
        } catch {}
      }
    : () => {};

  const todayStr = () => now().toISOString().slice(0, 10);

  /** Разовый снимок: баланс ключом из хранилища → JSON в хранилище. */
  async function snapshotDayBalance() {
    try {
      const st = await getStore();
      const active = getCredential ? await getCredential() : null;
      const s = await st.snapshot();
      const key = String((active ? active.api_key || active.key : s[storeKey]) || '').trim();
      const uid = String((active ? active.user_id : s[userField]) || '').trim();
      if (!key || !uid || !provider) return;
      const result = await provider.getUsage(key, uid);
      if (result.status !== 200) return;
      const bal = Number(((result.data && result.data.wallet) || {}).balance_usd);
      if (!Number.isFinite(bal)) return;
      await (
        await getStore()
      ).set(balanceKey, JSON.stringify({ date: todayStr(), balance_usd: bal }));
    } catch (e) {
      // Снимок дня не состоялся: карточка «за сутки» останется пустой до завтра
      warnEvent('tracker_snapshot_failed', {
        reason: e && e.message ? e.message : 'unknown',
      });
    }
  }

  /** Снимок, только если за сегодня его ещё нет. */
  async function ensureTodaySnapshot() {
    try {
      const s = await (await getStore()).snapshot();
      let savedDate = null;
      if (s[balanceKey]) {
        try {
          savedDate = JSON.parse(s[balanceKey]).date;
        } catch {}
      }
      if (savedDate !== todayStr()) await snapshotDayBalance();
    } catch (e) {
      // Нет доступа к хранилищу — снимок сегодня не сделать
      warnEvent('tracker_store_unavailable', {
        reason: e && e.message ? e.message : 'unknown',
      });
    }
  }

  /**
   * Планировщик: раз в минуту проверяет смену суток; снимок за сегодня
   * делается один раз — и при старте, и по таймеру. Возвращает промис
   * первой проверки (тесты). Без адаптера AgentRouter не запускается.
   */
  function start() {
    if (interval || !provider) return Promise.resolve();
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await ensureTodaySnapshot();
      } finally {
        busy = false;
      }
    };
    interval = setInterval(tick, intervalMs);
    if (typeof interval.unref === 'function') interval.unref();
    return tick();
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

  return {
    snapshotDayBalance,
    start,
    stop,
    getDayBalanceUsd,
    isRunning: () => interval !== null,
    enabled: Boolean(provider),
  };
}

module.exports = { createAgentRouterTracker, AGENTROUTER_DAY_BALANCE_KEY };
