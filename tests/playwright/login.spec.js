import { test, expect } from '@playwright/test';

// Страница входа (remote-режим, AIPANEL_AUTH_TOKEN). Сервер здесь без
// токена, поэтому /api/auth/* подменяются: тест проверяет саму страницу
// и её реакцию на ответы сервера.

const CONFIG = { ok: true, data: {}, providers: [], activeProvider: 'xkiro' };

async function mockAuth(page, { authEnabled = true, authenticated = false } = {}) {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authEnabled, authenticated }),
    })
  );
}

test.describe('Страница входа', () => {
  test('показывает форму токена', async ({ page }) => {
    await mockAuth(page);
    await page.goto('/login.html');
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#auth-token')).toBeVisible();
    await expect(page.locator('#login-error')).toBeHidden();
  });

  test('неверный токен → сообщение об ошибке, без перехода', async ({ page }) => {
    await mockAuth(page);
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_token', message: 'Неверный токен доступа' }),
      })
    );
    await page.goto('/login.html');
    await page.fill('#auth-token', 'wrong');
    await page.click('#login-submit');
    await expect(page.locator('#login-error')).toBeVisible();
    await expect(page.locator('#login-error')).toHaveText('Неверный токен доступа');
    expect(new URL(page.url()).pathname).toBe('/login.html');
  });

  test('верный токен → переход на запрошенную страницу', async ({ page }) => {
    await mockAuth(page);
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    );
    await page.route('**/api/config', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONFIG) })
    );
    await page.goto('/login.html?next=%2Fcheatsheet.html');
    await page.fill('#auth-token', 'right');
    await page.click('#login-submit');
    await page.waitForURL('**/cheatsheet.html');
    expect(new URL(page.url()).pathname).toBe('/cheatsheet.html');
  });

  test('уже активная сессия → сразу на запрошенную страницу', async ({ page }) => {
    await mockAuth(page, { authenticated: true });
    await page.route('**/api/config', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONFIG) })
    );
    await page.goto('/login.html?next=%2Fcheatsheet.html');
    await page.waitForURL('**/cheatsheet.html');
    expect(new URL(page.url()).pathname).toBe('/cheatsheet.html');
  });

  test('кнопка «Выйти» скрыта, когда вход не требуется', async ({ page }) => {
    await mockAuth(page, { authEnabled: false, authenticated: true });
    await page.goto('/');
    await expect(page.locator('#btn-logout')).toBeHidden();
  });

  test('кнопка «Выйти» видна при включённом входе', async ({ page }) => {
    await mockAuth(page);
    await page.goto('/');
    await expect(page.locator('#btn-logout')).toBeVisible();
  });
});
