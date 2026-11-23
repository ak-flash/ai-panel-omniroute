import { test, expect } from '@playwright/test';
import { waitForBoot } from './mock-api.js';

const COMMANDS = [
  'sudo npm install -g @getpaseo/cli@latest',
  'sudo -u paseo -H /usr/local/bin/opencode upgrade',
  'sudo systemctl restart paseo',
];

test.describe('Шпаргалка: обновление Paseo и OpenCode', () => {
  test('показывает команды по порядку и пояснения к выводу', async ({ page }) => {
    await page.goto('/cheatsheet.html');
    await waitForBoot(page);

    await expect(page.locator('.info-card-title')).toHaveText('Обновление Paseo и OpenCode');
    await expect(page.locator('.manage-cmd code')).toHaveText(COMMANDS);
    await expect(page.locator('.info-card')).toContainText('npm warn deprecated uuid@9.0.1');
    await expect(page.locator('.info-card')).toContainText(
      'OpenCode upgrade skipped: 2.3.2 is already installed'
    );
    await expect(page.locator('.info-card')).toContainText('перезапуск службы временно разорвёт');
  });

  test('каждая кнопка копирует только свою команду', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async text => {
            document.documentElement.dataset.copiedCommand = text;
          },
        },
      });
    });
    await page.goto('/cheatsheet.html');
    await waitForBoot(page);

    const buttons = page.locator('[data-copy-command]');
    await expect(buttons).toHaveCount(COMMANDS.length);
    for (const [index, command] of COMMANDS.entries()) {
      await buttons.nth(index).click();
      await expect(page.locator('html')).toHaveAttribute('data-copied-command', command);
      await expect(page.locator('#copy-status')).toHaveText('Скопировано!');
    }
  });

  test('сообщает об ошибке копирования', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Clipboard access denied');
          },
        },
      });
    });
    await page.goto('/cheatsheet.html');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Скопировать команду обновления Paseo' }).click();

    await expect(page.locator('#copy-status')).toHaveText('Не удалось скопировать');
  });

  test('команды и кнопки помещаются на мобильном экране', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/cheatsheet.html');
    await waitForBoot(page);

    for (const button of await page.locator('[data-copy-command]').all()) {
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  });
});
