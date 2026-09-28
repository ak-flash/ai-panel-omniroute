/* ============================================================
   AI Panel — проверка ключа провайдера после сохранения (P2-2).

   Раньше это была цепочка if/else на двести строк внутри
   saveProviderSettings. Отличия провайдеров — только подписи,
   наличие баланса в ответе и подсказка про 401, поэтому они
   сведены в таблицу PROVIDER_KEY_CHECKS.

   Зависимости (запрос, чтение флага, вывод строки) передаются
   параметрами: модуль не тянет за собой api.js и settings.js.
   ============================================================ */

import { MARK_OK, MARK_X } from './dom.js';
import { fmtUsd } from './formatters.js';

/** Баланс из ответа провайдера; отсутствие баланса — это 0. */
function balanceOf(data) {
  const wallet = (data && data.wallet) || {};
  return wallet.balance_usd ?? wallet.balance ?? 0;
}

/** Текст ошибки проверки: сообщение, иначе строковое представление. */
export function errorText(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Отличия провайдеров при проверке ключа.
 *
 * @typedef {object} KeyCheckDescriptor
 * @property {string} label           имя в интерфейсе
 * @property {string} noun            «ключ» или «токен» в именительном
 * @property {string} nounGenitive    он же в родительном («проверка ключа»)
 * @property {string} hasKeyFlag      ключ хранилища с флагом «ключ сохранён»
 * @property {string} logTag          префикс для console
 * @property {object|null} requestProvider  аргумент provider для запроса
 * @property {boolean} usesUserId     нужен ли User ID (AgentRouter)
 * @property {boolean} showsBalance   показывает ли ответ баланс
 * @property {string|null} planPrefix префикс плана в ответе
 * @property {string|null} hint401    подсказка при 401
 */
export const PROVIDER_KEY_CHECKS = {
  xkiro: {
    label: 'xKiro',
    noun: 'ключ',
    nounGenitive: 'ключа',
    hasKeyFlag: 'hasXkiroKey',
    logTag: '[xKiro]',
    requestProvider: null,
    usesUserId: false,
    showsBalance: true,
    planPrefix: ' · план: ',
    hint401: ' — проверьте ключ',
  },
  agentrouter: {
    label: 'AgentRouter',
    noun: 'токен',
    nounGenitive: 'токена',
    hasKeyFlag: 'hasAgentrouterKey',
    logTag: '[AgentRouter]',
    requestProvider: { id: 'agentrouter', name: 'AgentRouter' },
    usesUserId: true,
    showsBalance: true,
    planPrefix: null,
    hint401: null,
  },
  openrouter: {
    label: 'OpenRouter',
    noun: 'ключ',
    nounGenitive: 'ключа',
    hasKeyFlag: 'hasOpenrouterKey',
    logTag: '[OpenRouter]',
    requestProvider: { id: 'openrouter', name: 'OpenRouter' },
    usesUserId: false,
    showsBalance: true,
    planPrefix: ' · ',
    hint401: null,
  },
  experiential: {
    label: 'Experiential Labs',
    noun: 'ключ',
    nounGenitive: 'ключа',
    hasKeyFlag: 'hasExperientialKey',
    logTag: '[Experiential Labs]',
    requestProvider: { id: 'experiential', name: 'Experiential Labs' },
    usesUserId: false,
    showsBalance: false,
    planPrefix: null,
    hint401: null,
  },
  selora: {
    label: 'Selora',
    noun: 'ключ',
    nounGenitive: 'ключа',
    hasKeyFlag: 'hasSeloraKey',
    logTag: '[Selora]',
    requestProvider: { id: 'selora', name: 'Selora' },
    usesUserId: false,
    showsBalance: true,
    planPrefix: ' · план: ',
    hint401: ' — проверьте ключ',
  },
};

/** Строка «ключ работает…» для успешного ответа провайдера. */
export function successLine(descriptor, data) {
  const base = descriptor.label + ' ' + MARK_OK + ' ' + descriptor.noun + ' работает';
  if (!descriptor.showsBalance) return base;
  const plan = descriptor.planPrefix && data && data.plan ? descriptor.planPrefix + data.plan : '';
  return base + ' — баланс: ' + fmtUsd(balanceOf(data)) + plan;
}

/** Строка «ключ не прошёл проверку…» для ошибки. */
export function failureLine(descriptor, err) {
  let msg =
    descriptor.label +
    ' ' +
    MARK_X +
    ' ' +
    descriptor.noun +
    ' не прошёл проверку: ' +
    errorText(err);
  if (descriptor.hint401 && err && err.status === 401) msg += descriptor.hint401;
  return msg;
}

/** Строка для пустого поля: ключ либо уже сохранён, либо не задан. */
export function emptyLine(descriptor, hasStored) {
  return hasStored
    ? descriptor.label +
        ' ' +
        MARK_OK +
        ' ' +
        descriptor.noun +
        ' сохранён ранее — пустое поле его не меняет'
    : descriptor.label + ': ' + descriptor.noun + ' не задан';
}

/**
 * Проверяет ключ выбранного провайдера и печатает результат в
 * статусную строку раздела. Для неизвестного id (antigravity,
 * пустое значение) ничего не делает.
 *
 * @param {object} opts
 * @param {string} opts.id        id провайдера из селекта
 * @param {string} opts.candidate значение поля ключа (уже trim)
 * @param {string} [opts.userId]  AgentRouter User ID
 * @param {(path: string, payload: object) => Promise<object>} opts.request
 * @param {(flag: string) => unknown} opts.readFlag
 * @param {(line: string, isErr: boolean) => void} opts.setLine
 */
export async function runProviderKeyCheck(opts) {
  const descriptor = PROVIDER_KEY_CHECKS[opts.id];
  if (!descriptor) return; // antigravity и неизвестные — проверять нечего

  if (!opts.candidate) {
    // Пустое поле секрета = «не изменять»: ключ остаётся в хранилище.
    // Явно сообщаем об этом, чтобы пустое поле не выглядело как удаление
    const hasStored = Boolean(opts.readFlag(descriptor.hasKeyFlag));
    console.info(
      descriptor.logTag +
        ' ' +
        descriptor.noun +
        ' в поле пустой' +
        (hasStored ? ' — оставляю сохранённый' : '')
    );
    opts.setLine(emptyLine(descriptor, hasStored), false);
    return;
  }

  console.info(descriptor.logTag + ' проверка ' + descriptor.nounGenitive + '…');
  opts.setLine(descriptor.label + ': проверяю ' + descriptor.noun + '…', false);

  const payload = { key: opts.candidate };
  if (descriptor.requestProvider) payload.provider = descriptor.requestProvider;
  if (descriptor.usesUserId) payload.userId = opts.userId;

  try {
    const data = await opts.request('usage', payload);
    console.info(descriptor.logTag + ' ' + descriptor.noun + ' OK', data);
    opts.setLine(successLine(descriptor, data), false);
  } catch (err) {
    console.warn(descriptor.logTag + ' проверка не прошла', err);
    opts.setLine(failureLine(descriptor, err), true);
  }
}
