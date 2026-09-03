import { test, expect } from '@playwright/test';

test.describe('Smoke tests', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
  });

  test('models page loads', async ({ page }) => {
    await page.goto('/models.html');
    await expect(page.locator('#models-panel')).toBeVisible();
  });

  test('combo page loads', async ({ page }) => {
    await page.goto('/combo.html');
    await expect(page.locator('#combos-panel')).toBeVisible();
  });

  test('cheatsheet page loads', async ({ page }) => {
    await page.goto('/cheatsheet.html');
    await expect(page.locator('.manage-card')).toBeVisible();
  });

  test('theme toggle works', async ({ page }) => {
    await page.goto('/');
    const btn = page.locator('#btn-theme');
    // Начальная тема зависит от системной (prefers-color-scheme), поэтому
    // не хардкодим её: после клика тема обязана смениться на противоположную
    const current = await page.evaluate(() => {
      const t = document.documentElement.getAttribute('data-theme');
      if (t === 'light' || t === 'dark') return t;
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    });
    await btn.click();
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe(current === 'dark' ? 'light' : 'dark');
    await btn.click();
    const theme2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme2).toBe(current);
  });
});