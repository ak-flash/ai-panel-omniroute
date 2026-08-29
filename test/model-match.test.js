'use strict';

// Юнит-тесты сопоставления модели из combo с каталогом провайдера
// (public/model-match.js, ES-модуль — импортируется динамически).
// Воспроизводят баг с неверным тарифом: id из combo с префиксом
// провайдера («xKiro/qwen/qwen3.8-max:free») раньше матчился не на ту
// модель из каталога — вместо free-варианта выбиралась похожая платная.

const test = require('node:test');
const assert = require('node:assert/strict');

let matchModel;
test.before(async () => {
  ({ matchModel } = await import('../public/model-match.js'));
});

// Имитация каталога xKiro (/v1/models): premium-варианты идут
// раньше free — как в реальном каталоге, чтобы поймать баг порядка.
const CATALOG = [
  { id: 'qwen/qwen3.8-max', access_tier: 'premium' },
  { id: 'qwen/qwen3.8-max:free', access_tier: 'free' },
  { id: 'deepseek/deepseek-v4', access_tier: 'premium' },
  { id: 'deepseek/deepseek-v4-pro', access_tier: 'free' },
  { id: 'xai/grok-4.6', access_tier: 'paid' },
];

test('combo id с префиксом провайдера: free-вариант с суффиксом ":free"', () => {
  const m = matchModel(CATALOG, 'xKiro/qwen/qwen3.8-max:free');
  assert.equal(m && m.id, 'qwen/qwen3.8-max:free');
  assert.equal(m.access_tier, 'free');
});

test('combo id с префиксом провайдера: free-модель без суффикса', () => {
  const m = matchModel(CATALOG, 'xKiro/deepseek/deepseek-v4-pro');
  assert.equal(m && m.id, 'deepseek/deepseek-v4-pro');
  assert.equal(m.access_tier, 'free');
});

test('результат не зависит от порядка моделей в каталоге', () => {
  const reversed = [...CATALOG].reverse();
  assert.equal(matchModel(reversed, 'xKiro/qwen/qwen3.8-max:free').id,
    'qwen/qwen3.8-max:free');
  assert.equal(matchModel(reversed, 'xKiro/deepseek/deepseek-v4-pro').id,
    'deepseek/deepseek-v4-pro');
});

test('платный вариант без ":free" не матчится на free-вариант', () => {
  const m = matchModel(CATALOG, 'xKiro/qwen/qwen3.8-max');
  assert.equal(m && m.id, 'qwen/qwen3.8-max');
  assert.equal(m.access_tier, 'premium');
});

test('длинный префикс провайдера OmniRoute отбрасывается', () => {
  const m = matchModel(CATALOG, 'openai-compatible-chat-abc123/qwen/qwen3.8-max:free');
  assert.equal(m && m.id, 'qwen/qwen3.8-max:free');
});

test('регистр и дефисы не влияют на совпадение', () => {
  const m = matchModel(CATALOG, 'XKIRO/QWEN/Qwen3.8-Max:FREE');
  assert.equal(m && m.id, 'qwen/qwen3.8-max:free');
});

test('каталожный id как есть тоже совпадает', () => {
  const m = matchModel(CATALOG, 'deepseek/deepseek-v4-pro');
  assert.equal(m && m.id, 'deepseek/deepseek-v4-pro');
});

test('fallback по последнему сегменту (grok-4.6)', () => {
  const m = matchModel(CATALOG, 'xKiro/grok-4.6');
  assert.equal(m && m.id, 'xai/grok-4.6');
});

test('модель не найдена — null', () => {
  assert.equal(matchModel(CATALOG, 'xKiro/unknown/model-xyz'), null);
});

test('пустой id и пустой каталог — null', () => {
  assert.equal(matchModel(CATALOG, ''), null);
  assert.equal(matchModel(null, 'xKiro/qwen/qwen3.8-max:free'), null);
  assert.equal(matchModel([], 'xKiro/qwen/qwen3.8-max:free'), null);
});
