import { test, expect } from '@playwright/test';
import { mockProviders, mockCombos, XKIRO_USAGE, configResponse } from './mock-api.js';

// Сценарии этапа 6 плана улучшений: быстрый показ страницы, счётчик
// моделей, клавиатурная перестановка combo.

/** Ответ провайдера, который «думает» дольше таймаута теста. */
async function mockSlowProvider(page, body) {
  await page.route('**/api/config', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(configResponse()),
    })
  );
  await page.route('**/api/providers/xkiro/usage', async route => {
    await new Promise(resolve => setTimeout(resolve, 10000));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

test.describe('Главная: быстрый показ карточки', () => {
  test('страница видна до ответа провайдера (P3-1)', async ({ page }) => {
    await mockSlowProvider(page, XKIRO_USAGE);
    await page.goto('/');
    // is-booting снимается сразу, карточка статистики уже на экране
    await expect(page.locator('body')).not.toHaveClass(/is-booting/);
    await expect(page.locator('#cards')).toBeVisible();
    await expect(page.locator('#cards')).toHaveClass(/is-loading/);
  });

  test('карточка догружает баланс после медленного ответа (P3-1)', async ({ page }) => {
    await mockProviders(page);
    await page.goto('/');
    await expect(page.locator('#wallet-balance')).toHaveText('$82.31');
    await expect(page.locator('#cards')).not.toHaveClass(/is-loading/);
  });
});

test.describe('Главная: AgentRouter «За сегодня»', () => {
  async function mockAgentRouterUsage(page, data) {
    await page.route('**/api/providers/agentrouter/usage', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(data),
      })
    );
  }

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    );
    const config = configResponse({ hasAgentrouterKey: true });
    config.providers = config.providers.map(provider =>
      provider.id === 'agentrouter' ? { ...provider, hasKey: true } : provider
    );
    await mockProviders(page, { config });
    await mockCombos(page, []);
  });

  for (const [name, dayBalance, balance, expected] of [
    ['расход', 100, 82.31, '$17.69'],
    ['нулевой расход', 82.31, 82.31, '$0.00'],
    ['пополнение', 82.31, 100, '$0.00'],
    ['нулевой стартовый баланс', 0, -2.5, '$2.50'],
    ['нулевые остатки', 0, 0, '$0.00'],
    ['отрицательный стартовый баланс', -2, -5.25, '$3.25'],
    ['числовые строки', '100', '82.31', '$17.69'],
    ['нулевые числовые строки', '0', '0', '$0.00'],
  ]) {
    test(name, async ({ page }) => {
      await mockAgentRouterUsage(page, {
        day_balance_usd: dayBalance,
        wallet: { balance_usd: balance },
      });
      await page.goto('/');
      const today = page.locator('#ar-today');
      await expect(page.locator('#ar-card')).toBeVisible();
      await expect(today).toHaveText(expected);
      if (expected === '$0.00') await expect(today).not.toHaveClass(/val-used/);
      else await expect(today).toHaveClass(/val-used/);
    });
  }

  for (const [name, todayUsd, balance, expected] of [
    ['расход при пополнении', 17.69, 120, '$17.69'],
    ['ноль вместо разницы баланса', 0, 82.31, '$0.00'],
    ['null вместо разницы баланса', null, 82.31, '—'],
    ['числовая строка', '7.25', 82.31, '$7.25'],
    ['нулевая строка', '0', 82.31, '$0.00'],
    ['отрицательное значение', -2, 82.31, '—'],
    ['не число', '12 USD', 82.31, '—'],
    ['пустая строка', '', 82.31, '—'],
    ['бесконечность', 'Infinity', 82.31, '—'],
    ['булево значение', false, 82.31, '—'],
  ]) {
    test(`today_usd: ${name}`, async ({ page }) => {
      await mockAgentRouterUsage(page, {
        plan: 'pro',
        today_usd: todayUsd,
        day_balance_usd: 100,
        wallet: { balance_usd: balance },
      });
      await page.goto('/');
      await expect(page.locator('#ar-group')).toHaveText('PRO');
      const today = page.locator('#ar-today');
      await expect(today).toHaveText(expected);
      if (expected === '$0.00' || expected === '—') await expect(today).not.toHaveClass(/val-used/);
      else await expect(today).toHaveClass(/val-used/);
    });
  }

  for (const field of ['day_balance_usd', 'balance_usd']) {
    for (const [name, value] of [
      ['отсутствует', undefined],
      ['null', null],
      ['не число', '100 USD'],
      ['пустая строка', ''],
      ['пробелы', '   '],
      ['бесконечность', 'Infinity'],
      ['булево значение', false],
      ['массив', []],
      ['объект', {}],
    ]) {
      test(`${field}: ${name} — расход неизвестен`, async ({ page }) => {
        const data = { plan: 'pro', day_balance_usd: 100, wallet: { balance_usd: 82.31 } };
        if (field === 'day_balance_usd') data.day_balance_usd = value;
        else data.wallet.balance_usd = value;
        await mockAgentRouterUsage(page, data);
        await page.goto('/');
        await expect(page.locator('#ar-group')).toHaveText('PRO');
        await expect(page.locator('#ar-today')).toHaveText('—');
        await expect(page.locator('#ar-today')).not.toHaveClass(/val-used/);
      });
    }
  }

  for (const wallet of [undefined, null]) {
    test(`wallet: ${wallet} — расход неизвестен`, async ({ page }) => {
      await mockAgentRouterUsage(page, { plan: 'pro', day_balance_usd: 100, wallet });
      await page.goto('/');
      await expect(page.locator('#ar-group')).toHaveText('PRO');
      await expect(page.locator('#ar-today')).toHaveText('—');
      await expect(page.locator('#ar-today')).not.toHaveClass(/val-used/);
    });
  }

  test('today_usd: обновление сбрасывает выделение', async ({ page }) => {
    await mockAgentRouterUsage(page, {
      today_usd: 17.69,
      day_balance_usd: 100,
      wallet: { balance_usd: 82.31 },
    });
    await page.goto('/');
    const today = page.locator('#ar-today');
    await expect(today).toHaveText('$17.69');
    await expect(today).toHaveClass(/val-used/);

    for (const [todayUsd, expected] of [
      [null, '—'],
      [5, '$5.00'],
      [0, '$0.00'],
    ]) {
      await mockAgentRouterUsage(page, {
        today_usd: todayUsd,
        day_balance_usd: 100,
        wallet: { balance_usd: 82.31 },
      });
      await page.locator('#btn-refresh').click();
      await expect(today).toHaveText(expected);
      if (expected === '$5.00') await expect(today).toHaveClass(/val-used/);
      else await expect(today).not.toHaveClass(/val-used/);
    }
  });

  test('обновление сбрасывает выделение неизвестного и нулевого расхода', async ({ page }) => {
    await mockAgentRouterUsage(page, { day_balance_usd: 100, wallet: { balance_usd: 82.31 } });
    await page.goto('/');
    const today = page.locator('#ar-today');
    await expect(today).toHaveText('$17.69');
    await expect(today).toHaveClass(/val-used/);

    for (const [dayBalance, balance, expected] of [
      [null, 80, '—'],
      [80, 80, '$0.00'],
      [80, 75, '$5.00'],
      [75, 75, '$0.00'],
    ]) {
      await mockAgentRouterUsage(page, {
        day_balance_usd: dayBalance,
        wallet: { balance_usd: balance },
      });
      await page.locator('#btn-refresh').click();
      await expect(today).toHaveText(expected);
      if (expected === '$5.00') await expect(today).toHaveClass(/val-used/);
      else await expect(today).not.toHaveClass(/val-used/);
    }
  });
});

test.describe('Страница «Модели»: сводка результатов', () => {
  test('показывает «ничего не найдено» и счётчик (P3-7)', async ({ page }) => {
    await mockProviders(page);
    await page.goto('/models.html');
    const status = page.locator('#models-status');
    await expect(status).toContainText('Показано 3 из 3');
    await page.locator('#models-search').fill('нет-такой-модели');
    await expect(status).toContainText('Ничего не найдено');
    await expect(status).toHaveClass(/is-empty/);
  });
});

const COMBO = {
  id: 'coding',
  name: 'Coding',
  strategy: 'auto',
  models: [
    { model: 'openai/gpt-4o', id: 'a' },
    { model: 'anthropic/claude-sonnet', id: 'b' },
    { model: 'google/gemini-2', id: 'c' },
  ],
};

test.describe('Страница «Combo»: клавиатура', () => {
  test('стрелки на drag-handle меняют порядок и объявляют позицию (P3-5)', async ({ page }) => {
    const puts = [];
    await mockCombos(page, [COMBO]);
    // Регистрируем этот route последним: PUT записывается в puts,
    // GET отдаёт ту же combo, что и mockCombos
    await page.route('**/omniroute/api/combos/**', route => {
      if (route.request().method() === 'PUT') puts.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(COMBO),
      });
    });
    await mockProviders(page);
    await page.goto('/combo.html');
    const list = page.locator('#combo-models-list > li');
    await expect(list).toHaveCount(3);
    await expect(list.nth(0)).toContainText('gpt-4o');

    // Вторая строка: ArrowUp на drag-handle
    await list.nth(1).locator('.combo-drag-handle').focus();
    await list.nth(1).locator('.combo-drag-handle').press('ArrowUp');
    await expect(list.nth(0)).toContainText('claude-sonnet');
    await expect(page.locator('.visually-hidden[role="status"]').last()).toContainText('позиция 1');
    await expect.poll(() => puts.length).toBeGreaterThan(0);

    // фокус остался на строке, которой двигали
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      const li = el && el.closest ? el.closest('li[data-key]') : null;
      return li ? li.textContent.includes('claude-sonnet') : false;
    });
    expect(focused).toBe(true);
  });

  test('drag-handle доступен с клавиатуры (P3-5)', async ({ page }) => {
    await mockProviders(page);
    await mockCombos(page, [COMBO]);
    await page.goto('/combo.html');
    const list = page.locator('#combo-models-list > li');
    await expect(list).toHaveCount(3);
    await expect(list.nth(0).locator('.combo-drag-handle')).toHaveAttribute('role', 'button');
    await expect(list.nth(0).locator('.combo-drag-handle')).toHaveAttribute('tabindex', '0');
    await expect(list.nth(0).locator('.combo-drag-handle')).toHaveAttribute(
      'aria-label',
      /Переместить модель/
    );
  });
});
