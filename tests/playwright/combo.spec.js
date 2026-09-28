/* ============================================================
   Playwright — страница «Combo»: список маршрутов, targets,
   выключение модели и перестановка (PUT в OmniRoute).

   Все обращения к OmniRoute идут через серверный прокси
   /omniroute/* и подменяются: тесты не требуют запущенного
   OmniRoute и не зависят от состояния dev-базы.
   ============================================================ */

import { test, expect } from '@playwright/test';
import { configResponse, waitForBoot } from './mock-api.js';

const COMBO_A = {
  id: 'combo-a',
  name: 'Основной',
  models: [
    { id: 1, providerId: 'xkiro', model: 'gpt-4o', weight: 0 },
    { id: 2, providerId: 'openrouter', model: 'gpt-4o-mini', weight: 0 },
    { id: 3, providerId: 'xkiro', model: 'claude-sonnet', weight: 2 },
  ],
};

const COMBO_B = {
  id: 'combo-b',
  name: 'Запасной',
  models: [{ id: 4, providerId: 'xkiro', model: 'gpt-4o', weight: 0 }],
};

const XKIRO_MODELS = {
  data: [
    {
      id: 'gpt-4o',
      display_name: 'GPT-4o',
      access_tier: 'paid',
      pricing: { input: 2.5, output: 10 },
    },
    {
      id: 'claude-sonnet',
      display_name: 'Claude Sonnet',
      access_tier: 'paid',
      pricing: { input: 3, output: 15 },
    },
  ],
};

const OPENROUTER_MODELS = {
  data: [
    {
      id: 'gpt-4o-mini',
      display_name: 'GPT-4o mini',
      access_tier: 'free',
      pricing: { input: 0.15, output: 0.6 },
    },
  ],
};

/**
 * Подменяет прокси OmniRoute. PUT собираются в puts, чтобы проверить
 * фактический порядок моделей в сохранённом combo.
 */
async function mockOmni(page, { combos = [COMBO_A, COMBO_B], puts = [], configPuts = [] } = {}) {
  // Playwright применяет маршруты в обратном порядке регистрации, поэтому
  // catch-all обязан идти первым, иначе он перехватит и списки, и PUT.
  await page.route('**/omniroute/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    })
  );
  await page.route('**/api/config', async route => {
    if (route.request().method() === 'PUT') {
      configPuts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(configResponse({ comboActive: 'combo-a' })),
    });
  });
  await page.route('**/api/coding-ratings', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ source: 'none', ratings: {} }),
    })
  );
  await page.route('**/api/providers/xkiro/models', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(XKIRO_MODELS),
    })
  );
  await page.route('**/api/providers/openrouter/models', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(OPENROUTER_MODELS),
    })
  );
  await page.route('**/omniroute/api/usage/call-logs*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    })
  );
  await page.route('**/omniroute/api/combos', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: combos }),
    })
  );
  for (const combo of combos) {
    await page.route('**/omniroute/api/combos/' + combo.id, async route => {
      if (route.request().method() === 'PUT') {
        puts.push(route.request().postDataJSON());
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      // Детали combo — сам объект, без обёртки: страница читает data.models
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(combo),
      });
    });
  }
}

test.describe('Страница «Combo»', () => {
  test('список combo загружен, выбрана активная, targets на месте', async ({ page }) => {
    await mockOmni(page);
    await page.goto('/combo.html');
    await waitForBoot(page);

    const select = page.locator('#combo-select');
    await expect(select.locator('option')).toHaveCount(2);
    await expect(select).toHaveValue('combo-a');

    const items = page.locator('#combo-models-list li');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('gpt-4o');
    await expect(items.nth(0)).toHaveClass(/top/);
    await expect(items.nth(1)).toContainText('gpt-4o-mini');
    await expect(items.nth(2)).toContainText('claude-sonnet');
  });

  test('бейдж тарифа берётся из каталога провайдера самой модели', async ({ page }) => {
    await mockOmni(page);
    await page.goto('/combo.html');
    await waitForBoot(page);

    const items = page.locator('#combo-models-list li');
    // gpt-4o-mini в combo идёт от OpenRouter и там free
    await expect(items.nth(1).locator('.badge')).toHaveText('free');
    // gpt-4o в том же combo — xKiro, там paid
    await expect(items.nth(0).locator('.badge')).toHaveText('paid');
    // Вес модели виден отдельным бейджем
    await expect(items.nth(2)).toContainText('w:2');
  });

  test('переключение combo показывает targets второй combo', async ({ page }) => {
    await mockOmni(page);
    await page.goto('/combo.html');
    await waitForBoot(page);

    await page.locator('#combo-select').selectOption('combo-b');
    const items = page.locator('#combo-models-list li');
    await expect(items).toHaveCount(1);
    await expect(items.nth(0)).toContainText('gpt-4o');
  });

  test('выключение модели сохраняет её состояние в comboDisabled и PUT', async ({ page }) => {
    const configPuts = [];
    const omniPuts = [];
    await mockOmni(page, { puts: omniPuts, configPuts });
    await page.goto('/combo.html');
    await waitForBoot(page);

    const items = page.locator('#combo-models-list li');
    await items.nth(1).locator('.combo-switch').click();

    // Выключенная модель помечена и переезжает в конец списка
    const disabled = page.locator('#combo-models-list li').last();
    await expect(disabled).toHaveClass(/is-disabled/);
    await expect(disabled).toContainText('gpt-4o-mini');
    await expect(disabled.locator('.combo-switch')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#combo-targets-count')).toContainText('targets: 2');
    await expect(page.locator('#combo-targets-count')).toContainText('выключено: 1');

    await expect.poll(() => omniPuts.length).toBe(1);
    // Выключенная модель убирается из маршрута OmniRoute, её состояние
    // живёт в настройках панели (иначе включить обратно нечем — P1-6)
    const savedIds = omniPuts[0].models.map(m => m.model);
    expect(savedIds).toEqual(['gpt-4o', 'claude-sonnet']);

    const disabledPut = configPuts.find(p => 'comboDisabled' in p);
    expect(disabledPut, 'comboDisabled должен уехать на сервер').toBeTruthy();
    const savedDisabled = JSON.parse(disabledPut.comboDisabled);
    expect(Object.keys(savedDisabled)).toContain('combo-a');
    expect(JSON.stringify(savedDisabled['combo-a'])).toContain('gpt-4o-mini');
  });

  test('включение модели обратно возвращает её в маршрут', async ({ page }) => {
    const configPuts = [];
    const omniPuts = [];
    await mockOmni(page, { puts: omniPuts, configPuts });
    await page.goto('/combo.html');
    await waitForBoot(page);

    const items = page.locator('#combo-models-list li');
    await items.nth(2).locator('.combo-switch').click();
    const disabled = page.locator('#combo-models-list li').last();
    await expect(disabled).toHaveClass(/is-disabled/);
    await expect(disabled).toContainText('claude-sonnet');
    await expect.poll(() => omniPuts.length).toBe(1);
    expect(omniPuts[0].models.map(m => m.model)).not.toContain('claude-sonnet');

    await disabled.locator('.combo-switch').click();
    await expect(page.locator('#combo-models-list li').last()).not.toHaveClass(/is-disabled/);
    await expect.poll(() => omniPuts.length).toBe(2);
    expect(omniPuts[1].models.map(m => m.model)).toContain('claude-sonnet');

    // Список выключенных очищен — вернуть модель повторно не получится
    const lastPut = configPuts.filter(p => 'comboDisabled' in p).at(-1);
    expect(lastPut.comboDisabled).not.toContain('claude-sonnet');
  });

  test('ошибка при загрузке деталей combo показывается в статусе', async ({ page }) => {
    // Порядок регистрации важен: catch-all первым (см. mockOmni)
    await page.route('**/omniroute/**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      })
    );
    await page.route('**/api/config', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(configResponse({ comboActive: 'combo-a' })),
      })
    );
    await page.route('**/api/coding-ratings', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ source: 'none', ratings: {} }),
      })
    );
    await page.route('**/api/providers/xkiro/models', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(XKIRO_MODELS),
      })
    );
    await page.route('**/api/providers/openrouter/models', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(OPENROUTER_MODELS),
      })
    );
    await page.route('**/omniroute/api/usage/call-logs*', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      })
    );
    await page.route('**/omniroute/api/combos', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [COMBO_A] }),
      })
    );
    await page.route('**/omniroute/api/combos/combo-a', route =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'provider_error', message: 'OmniRoute недоступен' }),
      })
    );
    await page.goto('/combo.html');
    await waitForBoot(page);

    // Список combo виден, детали не загрузились — страница жива,
    // статус объясняет причину
    await expect(page.locator('#combo-select')).toHaveValue('combo-a');
    await expect(page.locator('#combo-status')).toContainText('OmniRoute');
    await expect(page.locator('#combo-models-list li')).toHaveCount(0);
  });

  test('пустой список combo показывает заглушку, а не пустую страницу', async ({ page }) => {
    await mockOmni(page, { combos: [] });
    await page.goto('/combo.html');
    await waitForBoot(page);

    await expect(page.locator('#combo-empty')).toBeVisible();
    await expect(page.locator('#combo-details')).toBeHidden();
  });
});
