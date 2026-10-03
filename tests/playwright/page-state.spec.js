import { test, expect } from '@playwright/test';
import { mockProviders, configResponse } from './mock-api.js';

// Единое состояние загрузки страницы (пункт 10 плана улучшений):
// offline/timeout, истёкшая сессия, upstream error и повтор с backoff.

/** Конфиг-маршрут нужен всегда — без него страница не инициализируется. */
async function mockConfig(page) {
  await page.route('**/api/config', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(configResponse()),
    })
  );
}

test.describe('Главная: состояния загрузки и ошибок', () => {
  test('успешная загрузка: статус ok и время обновления', async ({ page }) => {
    await mockProviders(page);
    await page.goto('/');
    await expect(page.locator('#wallet-balance')).toHaveText('$82.31');
    const dot = page.locator('#status-dot');
    await expect(dot).toHaveClass(/ok/);
    // Время последнего успешного обновления показано в шапке
    await expect(page.locator('#updated')).toBeVisible();
  });

  test('ошибка без данных: статус err и причина в баннере', async ({ page }) => {
    await mockConfig(page);
    await page.route('**/api/providers/xkiro/usage', route =>
      route.fulfill({ status: 502, body: JSON.stringify({ error: 'provider_error' }) })
    );
    await page.goto('/');
    // 502 повторяется с backoff, затем показывается ошибка
    await expect(page.locator('#status-dot')).toHaveClass(/err/, { timeout: 15000 });
    await expect(page.locator('#banner')).toBeVisible();
    await expect(page.locator('#banner-text')).toContainText('provider_error');
  });

  test('ошибка после успеха: stale с временем последнего обновления', async ({ page }) => {
    await mockProviders(page);
    await page.goto('/');
    await expect(page.locator('#wallet-balance')).toHaveText('$82.31');

    // Дальнейшие обновления падают: сетевая ошибка (offline)
    await page.route('**/api/providers/xkiro/usage', route => route.abort());
    // Возврат на вкладку триггерит обновление не чаще раза в минуту —
    // жмём «Обновить» явно
    await page.locator('#btn-refresh').click();
    await expect(page.locator('#status-dot')).toHaveClass(/stale/, { timeout: 15000 });
    await expect(page.locator('#status-text')).toContainText(/Данные от \d{2}:\d{2}/);
    // Устаревшие данные остаются на экране
    await expect(page.locator('#wallet-balance')).toHaveText('$82.31');
  });

  test('истёкшая сессия (401): баннер с предложением войти', async ({ page }) => {
    await mockConfig(page);
    await page.route('**/api/providers/xkiro/usage', route =>
      route.fulfill({ status: 401, body: JSON.stringify({ error: 'auth_required' }) })
    );
    await page.goto('/');
    // 401 не повторяется — ошибка показывается сразу
    await expect(page.locator('#status-dot')).toHaveClass(/err/, { timeout: 5000 });
    await expect(page.locator('#banner')).toBeVisible();
    await expect(page.locator('#banner-text')).toContainText(/Сессия истекла/i);
  });

  test('открытый circuit breaker: статус с временем повтора', async ({ page }) => {
    await mockConfig(page);
    await page.route('**/api/providers/xkiro/usage', route =>
      route.fulfill({
        status: 503,
        body: JSON.stringify({ error: 'provider_circuit_open', retry_after_ms: 2000 }),
      })
    );
    await page.goto('/');
    await expect(page.locator('#status-dot')).toHaveClass(/err/, { timeout: 15000 });
    await expect(page.locator('#status-text')).toContainText(/повтор через \d+ с/);
  });
});
