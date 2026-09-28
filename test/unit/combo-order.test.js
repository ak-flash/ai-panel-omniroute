'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let reorderItems;
let toComboIndex;
test.before(async () => {
  ({ reorderItems, toComboIndex } = await import('../../public/js/combo-order.js'));
});

test('maps disabled rows after enabled targets', () => {
  assert.equal(toComboIndex(0, 3), 0);
  assert.equal(toComboIndex(2, 3), 2);
  assert.equal(toComboIndex(3, 3), 3);
  assert.equal(toComboIndex(null, 3), null);
});

test('reorders items without mutating source', () => {
  const source = ['a', 'b', 'c'];
  assert.deepEqual(reorderItems(source, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(source, ['a', 'b', 'c']);
});

test('keeps items for no-op and invalid indexes', () => {
  const source = ['a', 'b'];
  assert.deepEqual(reorderItems(source, 1, 1), source);
  assert.deepEqual(reorderItems(source, -1, 1), source);
  assert.deepEqual(reorderItems(source, 0, 3), source);
});
