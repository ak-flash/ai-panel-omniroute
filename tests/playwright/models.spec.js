/* ============================================================
   Playwright — страница «Модели»: каталог, фильтры и поиск.

   Конфигурация, каталог провайдера и рейтинг для кодинга
   подменяются: сценарии не зависят от ключей провайдеров и от
   состояния dev-базы.
   ============================================================ */

import { test, expect } from '@playwright/test';
import { configResponse, XKIRO_MODELS, mockCodingRatings, waitForBoot } from './mock-api.js';

/** Готовая страница моделей с мокнутым каталогом. */
async function openModels(page, models = XKIRO_MODELS) {
  await page.route('**/api/config', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(configResponse({ modelsProvider: 'xkiro' })),
    })
  );
  await page.route('**/api/providers/xkiro/models', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(models) })
  );
  await mockCodingRatings(page);
  await page.goto('/models.html');
  await waitForBoot(page);
}

test.describe('Страница «Модели»', () => {
  test('каталог отрисован: строки, тариф, цены, «—» вместо нуля', async ({ page }) => {
    await openModels(page);
    const rows = page.locator('#models-body tr');
    await expect(rows).toHaveCount(3);

    // Сортировка по цене входа: gpt-4o-mini (0.15) → gpt-4o (2.5) → claude (—)
    await expect(rows.nth(0)).toContainText('gpt-4o-mini');
    await expect(rows.nth(1)).toContainText('gpt-4o');
    await expect(rows.nth(2)).toContainText('claude-sonnet');

    // Модель без цены показывает «—» в обеих ценовых ячейках, а не 0.00 (P1-8).
    // Ячейки .num-col идут подряд: контекст, цена входа, цена выхода.
    const cells = rows.nth(2).locator('.num-col');
    await expect(cells).toHaveCount(3);
    await expect(cells.nth(1)).toHaveText('—');
    await expect(cells.nth(2)).toHaveText('—');
    // Контекст при этом показывается
    await expect(cells.nth(0)).toHaveText('200 тыс.');

    // Бейджи тарифа
    await expect(rows.nth(0).locator('.badge.free')).toHaveText('free');
    await expect(rows.nth(1).locator('.badge.paid')).toHaveText('paid');
  });

  test('поиск фильтрует строки и обнуляет результат', async ({ page }) => {
    await openModels(page);
    const search = page.locator('#models-search');
    await search.fill('mini');
    await expect(page.locator('#models-body tr')).toHaveCount(1);
    await expect(page.locator('#models-body')).toContainText('gpt-4o-mini');

    await search.fill('нетакого');
    await expect(page.locator('#models-body tr')).toHaveCount(0);

    await search.fill('');
    await expect(page.locator('#models-body tr')).toHaveCount(3);
  });

  test('поиск не дебунсится заново на каждый ввод: один проход по данным', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/providers/xkiro/models', route => {
      requests += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(XKIRO_MODELS),
      });
    });
    await page.route('**/api/config', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(configResponse({ modelsProvider: 'xkiro' })),
      })
    );
    await mockCodingRatings(page);
    await page.goto('/models.html');
    await waitForBoot(page);
    const afterBoot = requests;

    for (const value of ['g', 'gp', 'gpt', 'gpt-', 'gpt-4']) {
      await page.locator('#models-search').fill(value);
    }
    await expect(page.locator('#models-body tr')).toHaveCount(2);
    assertRequestsUnchanged(requests, afterBoot);
  });

  test('фильтр по тарифу оставляет только нужные модели', async ({ page }) => {
    await openModels(page);
    await page.locator('#models-tier').selectOption('free');
    await expect(page.locator('#models-body tr')).toHaveCount(1);
    await expect(page.locator('#models-body')).toContainText('gpt-4o-mini');

    await page.locator('#models-tier').selectOption('paid');
    await expect(page.locator('#models-body tr')).toHaveCount(2);

    await page.locator('#models-tier').selectOption('all');
    await expect(page.locator('#models-body tr')).toHaveCount(3);
  });

  test('ошибка загрузки каталога показывается в статусе, а не роняет страницу', async ({
    page,
  }) => {
    await page.route('**/api/config', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(configResponse({ modelsProvider: 'xkiro' })),
      })
    );
    await page.route('**/api/providers/xkiro/models', route =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'provider_error', message: 'Провайдер недоступен' }),
      })
    );
    await mockCodingRatings(page);
    await page.goto('/models.html');
    await waitForBoot(page);

    await expect(page.locator('#models-status')).toContainText('Ошибка загрузки каталога');
    await expect(page.locator('#models-status')).toContainText('Провайдер недоступен');
  });

  test('селект провайдера показывает список провайдеров из конфигурации', async ({ page }) => {
    await openModels(page);
    const select = page.locator('#models-provider');
    await expect(select.locator('option')).toHaveCount(3);
    await expect(select).toHaveValue('xkiro');
    await expect(page.locator('#models-provider-name')).toHaveText('xKiro');
  });
});

/** Каталог не перезапрашивается на каждый символ поиска. */
function assertRequestsUnchanged(actual, expected) {
  if (actual !== expected) {
    throw new Error('каталог перезапрошен при вводе в поиск: ' + expected + ' → ' + actual);
  }
}
