/* ============================================================
   AI Panel — рейтинг моделей для кодинга (только онлайн).

   Источник: Artificial Analysis Coding Index via OpenRouter
   Benchmarks API (GET /api/v1/benchmarks?source=artificial-analysis
   &task_type=coding). Эвристика удалена — показываются только
   модели, покрытые бенчмарком; остальные — «нет данных».
   ============================================================ */

import { normModelName } from './model-match.js';

let _onlineMap = null;
let _onlineMeta = null;

/**
 * Установить онлайн-рейтинги, загруженные с /api/coding-ratings.
 * @param {object|null} data — { ratings, updatedAt, source, citation, sourceUrl }
 */
export function setOnlineRatings(data) {
  if (!data || typeof data.ratings !== 'object') {
    _onlineMap = null;
    _onlineMeta = null;
    return;
  }
  _onlineMap = data.ratings;
  _onlineMeta = data;
}

export function getOnlineMeta() {
  return _onlineMeta;
}

/**
 * Пытается найти онлайн-оценку для модели по нескольким ключам:
 * полный id, bare-имя после '/', display_name.
 * @returns {{ score, tier, reasons, source, displayName } | null}
 */
export function resolveOnlineRating(model) {
  if (!_onlineMap || !model || typeof model !== 'object') return null;
  const keys = [];
  const id = model.id || '';
  const name = model.display_name || '';
  const nid = normModelName(id);
  const nname = normModelName(name);
  if (nid) keys.push(nid);
  // bare после слэша
  if (id.includes('/')) {
    const bare = id.split('/').pop();
    const nb = normModelName(bare);
    if (nb && !keys.includes(nb)) keys.push(nb);
  }
  // без первого сегмента (провайдер OmniRoute)
  if (id.includes('/')) {
    const withoutFirst = id.split('/').slice(1).join('/');
    const nw = normModelName(withoutFirst);
    if (nw && !keys.includes(nw)) keys.push(nw);
  }
  if (nname && !keys.includes(nname)) keys.push(nname);

  for (const k of keys) {
    const hit = _onlineMap[k];
    if (hit && typeof hit.score === 'number') return hit;
  }
  return null;
}

/**
 * Итоговый рейтинг — только онлайн. Если модель не покрыта
 * бенчмарком, возвращается «нет данных» (score:null, tier:'none').
 * @returns {{ score:number|null, tier:string, reasons:string[], source:'online'|'none', online:boolean, hasOnline:boolean }}
 */
export function codingRatingResolved(model) {
  const online = resolveOnlineRating(model);
  if (online) {
    return {
      score: online.score,
      tier: online.tier || (online.score >= 70 ? 'top' : online.score >= 40 ? 'good' : 'low'),
      reasons: Array.isArray(online.reasons) && online.reasons.length
        ? online.reasons
        : [online.source || 'онлайн-бенчмарк'],
      source: 'online',
      online: true,
      hasOnline: true,
      citation: online.citation || (_onlineMeta && _onlineMeta.citation) || '',
      sourceUrl: online.sourceUrl || (_onlineMeta && _onlineMeta.sourceUrl) || '',
      displayName: online.displayName || '',
    };
  }
  return {
    score: null,
    tier: 'none',
    reasons: ['нет онлайн-данных'],
    source: 'none',
    online: false,
    hasOnline: false,
    citation: (_onlineMeta && _onlineMeta.citation) || '',
    sourceUrl: (_onlineMeta && _onlineMeta.sourceUrl) || '',
    displayName: '',
  };
}

export function codingScoreResolved(model) {
  const r = codingRatingResolved(model);
  // null → -1 чтобы такие модели уходили вниз при сортировке desc
  return r.score == null ? -1 : r.score;
}

// Совместимость: старые импорты codingRating/codingScore теперь
// алиасы к онлайн-only версии (эвристика удалена).
export const codingRating = codingRatingResolved;
export const codingScore = codingScoreResolved;
