/** Восстанавливает порядок известных карточек, добавляя новые в конец. */
export function normalizeProviderCardOrder(cardIds, savedOrder) {
  const remaining = new Set(cardIds);
  const order = [];
  if (Array.isArray(savedOrder)) {
    for (const id of savedOrder) {
      if (remaining.delete(id)) order.push(id);
    }
  }
  return [...order, ...remaining];
}
