/* ============================================================
   AI Panel — сопоставление модели из combo с каталогом провайдера
   ============================================================
   ES-модуль: импортируется страницами «Модели» и «Combo», а также
   используется в тестах через dynamic import (node:test).
   */

// Нормализует id модели: нижний регистр, остаются только буквы,
// цифры, точка, двоеточие и слэш. «:» и «/» важны: они отделяют
// вариант (":free") и сегменты, иначе «qwen3.8-max:free» после
// нормализации совпадает с платным «qwen3.8-max».
export function normModelName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9.:/]/g, '');
}

/**
 * Ищет в каталоге models модель по id из combo.
 *
 * id из combo обычно длиннее каталожного: OmniRoute добавляет
 * префикс провайдера — «xKiro/deepseek/deepseek-v4-pro» при
 * каталожном «deepseek/deepseek-v4-pro». Поэтому по очереди
 * сравниваем несколько кандидатов:
 *   1) полный id;
 *   2) id без первого сегмента (префикса провайдера OmniRoute);
 *   3) последний сегмент.
 *
 * Точное совпадение любого кандидата надёжнее нечёткого поиска
 * по вхождению строк: тот брал первую похожую модель из каталога
 * (например, платную «qwen/qwen3.8-max» вместо «qwen/qwen3.8-max:free»)
 * и показывал неверный тариф.
 *
 * Если точного совпадения нет, ищем по вхождению — но берём самое
 * длинное (наиболее конкретное) совпадение, а не первое попавшееся.
 * Возвращает найденную модель или null.
 */
export function matchModel(models, id) {
  if (!id || !Array.isArray(models)) return null;

  const raw = String(id);
  const segs = raw.split('/');
  const candidates = [
    normModelName(raw),                                            // полный id
    segs.length > 1 ? normModelName(segs.slice(1).join('/')) : '', // без префикса провайдера
    segs.length > 2 ? normModelName(segs[segs.length - 1]) : '',   // последний сегмент
  ].filter(Boolean);

  // 1) точное совпадение кандидата с id из каталога
  for (const cand of candidates) {
    const m = models.find((x) => normModelName(x.id) === cand);
    if (m) return m;
  }

  // 2) нечёткий поиск по вхождению — самое длинное совпадение
  let best = null;
  let bestLen = 0;
  for (const x of models) {
    const nx = normModelName(x.id);
    if (nx.length <= 3) continue;
    const hit = candidates.some((c) => c.includes(nx) || nx.includes(c));
    if (hit && nx.length > bestLen) {
      best = x;
      bestLen = nx.length;
    }
  }
  return best;
}
