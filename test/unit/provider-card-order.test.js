'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let normalizeProviderCardOrder;
test.before(async () => {
  ({ normalizeProviderCardOrder } = await import('../../public/js/provider-card-order.js'));
});

test('provider cards: missing or invalid saved order keeps the default', () => {
  const ids = ['cards', 'selora-card', 'or-card'];
  for (const saved of [null, undefined, {}, 'or-card', 42, []]) {
    assert.deepEqual(normalizeProviderCardOrder(ids, saved), ids);
  }
});

test('provider cards: restores saved order and appends new cards', () => {
  const ids = ['cards', 'selora-card', 'or-card', 'experiential-card'];
  const saved = ['or-card', 'cards'];
  assert.deepEqual(normalizeProviderCardOrder(ids, saved), [
    'or-card',
    'cards',
    'selora-card',
    'experiential-card',
  ]);
  assert.deepEqual(ids, ['cards', 'selora-card', 'or-card', 'experiential-card']);
  assert.deepEqual(saved, ['or-card', 'cards']);
});

test('provider cards: ignores duplicates, unknown IDs and invalid entries', () => {
  assert.deepEqual(
    normalizeProviderCardOrder(
      ['cards', 'selora-card', 'or-card'],
      ['missing', 'or-card', null, 'or-card', {}, 5, 'cards']
    ),
    ['or-card', 'cards', 'selora-card']
  );
});

test('provider cards: empty dashboard ignores obsolete saved cards', () => {
  assert.deepEqual(normalizeProviderCardOrder([], ['or-card']), []);
});
