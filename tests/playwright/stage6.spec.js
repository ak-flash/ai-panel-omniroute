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
