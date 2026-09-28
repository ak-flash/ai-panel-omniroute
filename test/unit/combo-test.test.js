'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let comboTestModelId;
test.before(async () => {
  ({ comboTestModelId } = await import('../../public/js/combo-test.js'));
});

test('comboTestModelId prefers normalized modelId', () => {
  assert.equal(
    comboTestModelId({ modelId: 'provider/model', display: 'fallback' }),
    'provider/model'
  );
});

test('comboTestModelId reads model fields from raw target', () => {
  assert.equal(
    comboTestModelId({ _raw: { model: 'raw/model' }, display: 'fallback' }),
    'raw/model'
  );
  assert.equal(comboTestModelId({ _raw: { modelId: 'raw/id' }, display: 'fallback' }), 'raw/id');
  assert.equal(comboTestModelId({ _raw: { id: 'raw/id' }, display: 'fallback' }), 'raw/id');
});

test('comboTestModelId falls back to display', () => {
  assert.equal(comboTestModelId({ display: 'shown/model' }), 'shown/model');
});
