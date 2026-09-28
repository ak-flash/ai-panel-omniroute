/** Pure helpers for ordering enabled combo targets. */

/**
 * Converts an index from the rendered list to an index in the enabled-target array.
 * Disabled targets are rendered after enabled targets.
 *
 * @param {number|null} visibleIndex
 * @param {number} enabledCount
 * @returns {number|null}
 */
export function toComboIndex(visibleIndex, enabledCount) {
  if (visibleIndex == null) return null;
  return visibleIndex < enabledCount ? visibleIndex : enabledCount;
}

/**
 * Returns a reordered copy without mutating the input array.
 *
 * @template T
 * @param {T[]} items
 * @param {number|null} from
 * @param {number|null} to
 * @returns {T[]}
 */
export function reorderItems(items, from, to) {
  if (from == null || to == null || from === to) return [...items];
  if (from < 0 || from >= items.length || to < 0 || to > items.length) return [...items];
  const result = [...items];
  const [moved] = result.splice(from, 1);
  result.splice(to, 0, moved);
  return result;
}
