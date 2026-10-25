'use strict';

// ============================================================
// Ежедневный снимок баланса AgentRouter.
//
// Зависимости приходят параметрами (store через getStore, адаптер
// провайдера, поля хранилища, часы now) — модуль не трогает env и fs.
// ============================================================

const { fingerprint } = require('./ttl-cache');

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
  let pendingSave = Promise.resolve();

  function finiteNumber(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function spentUsd(value) {
    const number = finiteNumber(value);
    return number !== null && number >= 0 ? number : null;
  }

  function readSnapshots(value, date) {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || parsed.date !== date) return {};
      if (parsed.snapshots && typeof parsed.snapshots === 'object') return parsed.snapshots;
      return { [parsed.owner || '']: parsed };
    } catch {
      return {};
    }
  }

  function validSnapshot(snapshot) {
    if (!snapshot) return null;
    const balance = finiteNumber(snapshot.balance_usd);
    if (balance === null) return null;
    return { balance_usd: balance, used_usd: spentUsd(snapshot.used_usd) };
  }

  async function credentials() {
    const active = getCredential ? await getCredential() : null;
    const s = await (await getStore()).snapshot();
    return {
      key: String((active && (active.api_key || active.key)) || s[storeKey] || '').trim(),
      uid: String((active && active.user_id) || s[userField] || '').trim(),
    };
  }

  function serializeSave(operation) {
    const save = pendingSave.then(operation);
    pendingSave = save.then(
      () => {},
      () => {}
    );
    return save;
  }

  function recordUsage(data, key, uid, date = todayStr()) {
    const save = serializeSave(async () => {
      const balance = finiteNumber(data && data.wallet && data.wallet.balance_usd);
      if (balance === null || !key || !uid || date !== todayStr()) return null;
      const owner = fingerprint(`${key}:${uid}`);
      const st = await getStore();
      const s = await st.snapshot();
      const snapshots = readSnapshots(s[balanceKey], date);
      let changed = false;
      const legacy = validSnapshot(snapshots['']);
      if (legacy) {
        const configured = await credentials();
        if (configured.key && configured.uid) {
          const configuredOwner = fingerprint(`${configured.key}:${configured.uid}`);
          if (!validSnapshot(snapshots[configuredOwner])) snapshots[configuredOwner] = legacy;
          delete snapshots[''];
          changed = true;
        }
      }
      const used = spentUsd(data.used_usd);
      let snapshot = validSnapshot(snapshots[owner]);
      if (!snapshot) {
        snapshot = { balance_usd: balance, used_usd: used };
        snapshots[owner] = snapshot;
        changed = true;
      }
      if (changed) await st.set(balanceKey, JSON.stringify({ date, snapshots }));

      const balanceDelta = Math.max(0, snapshot.balance_usd - balance);
      const usedDelta =
        spentUsd(snapshot.used_usd) !== null && used !== null && used >= spentUsd(snapshot.used_usd)
          ? used - spentUsd(snapshot.used_usd)
          : null;
      const today = usedDelta === null ? balanceDelta : Math.max(balanceDelta, usedDelta);
      return {
        day_balance_usd: snapshot.balance_usd,
        today_usd: today === null ? null : Math.round(today * 1e6) / 1e6,
      };
    });
    return save.catch(e => {
      warnEvent('tracker_snapshot_failed', {
        reason: e && e.message ? e.message : 'unknown',
      });
      return null;
    });
  }

  async function snapshotDayBalance() {
    try {
      const { key, uid } = await credentials();
      if (!key || !uid || !provider) return;
      const date = todayStr();
      const result = await provider.getUsage(key, uid);
      if (result.status === 200) await recordUsage(result.data, key, uid, date);
    } catch (e) {
      warnEvent('tracker_snapshot_failed', {
        reason: e && e.message ? e.message : 'unknown',
      });
    }
  }

  async function ensureTodaySnapshot() {
    try {
      const { key, uid } = await credentials();
      if (!key || !uid) return;
      const date = todayStr();
      const owner = fingerprint(`${key}:${uid}`);
      const hasSnapshot = await serializeSave(async () => {
        const st = await getStore();
        const s = await st.snapshot();
        const snapshots = readSnapshots(s[balanceKey], date);
        const legacy = validSnapshot(snapshots['']);
        if (legacy && date === todayStr()) {
          if (!validSnapshot(snapshots[owner])) snapshots[owner] = legacy;
          delete snapshots[''];
          await st.set(balanceKey, JSON.stringify({ date, snapshots }));
        }
        return validSnapshot(snapshots[owner]) !== null;
      });
      if (!hasSnapshot) await snapshotDayBalance();
    } catch (e) {
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
      const { key, uid } = await credentials();
      const s = await (await getStore()).snapshot();
      const snapshots = readSnapshots(s[balanceKey], todayStr());
      const snapshot =
        validSnapshot(snapshots[fingerprint(`${key}:${uid}`)]) || validSnapshot(snapshots['']);
      return snapshot ? snapshot.balance_usd : null;
    } catch {
      return null;
    }
  }

  return {
    snapshotDayBalance,
    recordUsage,
    start,
    stop,
    getDayBalanceUsd,
    isRunning: () => interval !== null,
    enabled: Boolean(provider),
  };
}

module.exports = { createAgentRouterTracker, AGENTROUTER_DAY_BALANCE_KEY };
