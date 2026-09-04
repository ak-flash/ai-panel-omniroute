/* ============================================================
   Playwright — табы диалога настроек и раздельное сохранение.

   /api/config мокается на уровне контекста браузера: GET отдаёт
   пустой конфиг, PUT отвечается ok. Тесты не зависят от состояния
   dev-базы и не пишут в неё; тела PUT перехватываются для
   проверок «раздел сохраняет только свои ключи».
   ============================================================ */

import { test, expect } from '@playwright/test';

const EMPTY_CONFIG = {
  ok: true,
  data: {
    aliases: '', comboActive: '', dlgProvider: 'xkiro', dlgTab: '', modelsProvider: '',
    statsProvider: '', notificationThresholds: '', agentrouterUserId: '', omniUrl: '',
    hasXkiroKey: false, hasAgentrouterKey: false, hasOmniRoute: false, hasOmniKey: false,
    hasGoogleToken: false,
  },
  providers: [],
  activeProvider: null,
};

// Ключи хранилища по разделам: ни один батч не должен их смешивать
const SECTIONS = [
  ['xkiroKey', 'agentrouterKey', 'agentrouterUserId'],
  ['omniUrl', 'omniKey'],
  ['notificationThresholds'],
  ['aliases'],
  ['dlgTab'],
  ['dlgProvider'],
];

async function mockConfig(page, puts, dataOverrides = {}) {
  const config = { ...EMPTY_CONFIG, data: { ...EMPTY_CONFIG.data, ...dataOverrides } };
  await page.route('**/api/config', async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      if (puts) puts.push(req.postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) });
  });
}

async function openSettings(page) {
  await page.goto('/');
  const btn = page.locator('#btn-settings');
  // На узких экранах кнопка настроек свёрнута в меню топбара
  if (!(await btn.isVisible())) await page.locator('#btn-topbar-toggle').click();
  await btn.click();
  await page.locator('#dlg').waitFor({ state: 'visible' });
}

test.describe('Настройки: табы и раздельное сохранение', () => {
  test('по умолчанию открыта вкладка «Провайдер»', async ({ page }) => {
    await mockConfig(page, null);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettings(page);

    await expect(page.locator('#dlg-tab-provider')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#dlg-panel-provider')).toBeVisible();
    for (const id of ['dlg-panel-omni', 'dlg-panel-notifications', 'dlg-panel-aliases']) {
      await expect(page.locator(`#${id}`)).toBeHidden();
    }
    await expect(page.locator('#dlg-save-provider')).toBeVisible();
    await expect(page.locator('#dlg-remove')).toBeVisible();
  });

  test('каждый раздел сохраняет только свои ключи', async ({ page }) => {
    const puts = [];
    await mockConfig(page, puts);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettings(page);

    // Уведомления: Enter в поле сохраняет раздел и не закрывает диалог
    await page.locator('#dlg-tab-notifications').click();
    await page.locator('#dlg-th-xkiro-short').fill('75');
    await page.locator('#dlg-th-xkiro-short').press('Enter');
    await expect(page.locator('#dlg')).toBeVisible();
    await expect(page.locator('#dlg-result-notifications')).toContainText('Сохранено');
    await expect(page.locator('#dlg-result-notifications')).toHaveClass(/ok/);
    expect(puts.find((p) => 'notificationThresholds' in p))
      .toEqual({ notificationThresholds: '{"xkiro":{"short_window_pct":75}}' });

    // Провайдер: ключ сохраняется, алиасы/omni/пороги не улетают
    await page.locator('#dlg-tab-provider').click();
    await page.locator('#dlg-key').fill('sk-test-123');
    await page.locator('#dlg-key').press('Enter');
    await expect(page.locator('#dlg-result-provider')).toContainText('Сохранено');
    expect(puts.find((p) => 'xkiroKey' in p))
      .toEqual({ agentrouterUserId: '', xkiroKey: 'sk-test-123' });

    // OmniRoute: пустой адрес сохраняется без проверки
    await page.locator('#dlg-tab-omni').click();
    await page.locator('#dlg-save-omni').click();
    await expect(page.locator('#dlg-result-omni')).toContainText('OmniRoute: не задан');
    expect(puts.find((p) => 'omniUrl' in p)).toEqual({ omniUrl: '' });

    // Имена: добавленная строка уходит в алиасы
    await page.locator('#dlg-tab-aliases').click();
    await page.locator('#dlg-alias-add').click();
    const row = page.locator('.alias-row').last();
    await row.locator('input').nth(0).fill('test-id');
    await row.locator('input').nth(1).fill('Test Name');
    await page.locator('#dlg-save-aliases').click();
    await expect(page.locator('#dlg-result-aliases')).toContainText('Сохранено');
    expect(puts.find((p) => 'aliases' in p)).toEqual({ aliases: '[["test-id","Test Name"]]' });

    // Инвариант: ни один батч не смешивает ключи разных разделов
    for (const p of puts) {
      const keys = Object.keys(p);
      const pure = SECTIONS.some((sec) => keys.every((k) => sec.includes(k)));
      expect(pure, 'смешанный батч: ' + JSON.stringify(p)).toBe(true);
    }
  });

  test('пустое поле ключа не затирает сохранённый ключ', async ({ page }) => {
    const puts = [];
    // Ключи установлены на сервере (в форме они не возвращаются — поля пустые)
    await mockConfig(page, puts, { hasXkiroKey: true, hasAgentrouterKey: true, hasOmniKey: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettings(page);

    // Провайдер: сохраняем с пустым полем ключа — секрет в PUT не уходит
    await page.locator('#dlg-save-provider').click();
    await expect(page.locator('#dlg-result-provider')).toContainText('ключ сохранён ранее');
    const providerPut = puts.at(-1);
    expect('xkiroKey' in providerPut).toBe(false);
    expect('agentrouterKey' in providerPut).toBe(false);

    // OmniRoute: пустое поле ключа — omniKey не уходит, статус предупреждает
    await page.locator('#dlg-tab-omni').click();
    await page.locator('#dlg-save-omni').click();
    await expect(page.locator('#dlg-result-omni')).toContainText('Ключ сохранён ранее');
    expect('omniKey' in puts.at(-1)).toBe(false);
  });

  test('клавиатура: стрелки и Home/End переключают табы', async ({ page }) => {
    await mockConfig(page, null);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettings(page);

    await page.locator('#dlg-tab-provider').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#dlg-tab-omni')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#dlg-tab-omni')).toBeFocused();
    await expect(page.locator('#dlg-panel-omni')).toBeVisible();

    await page.keyboard.press('End');
    await expect(page.locator('#dlg-panel-aliases')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(page.locator('#dlg-panel-provider')).toBeVisible();
  });

  test('Antigravity: без ключа — кнопки сохранения и удаления скрыты', async ({ page }) => {
    await mockConfig(page, null);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettings(page);

    await page.locator('#dlg-provider').selectOption('antigravity');
    await expect(page.locator('#dlg-save-provider')).toBeHidden();
    await expect(page.locator('#dlg-remove')).toBeHidden();

    await page.locator('#dlg-provider').selectOption('xkiro');
    await expect(page.locator('#dlg-save-provider')).toBeVisible();
    await expect(page.locator('#dlg-remove')).toBeVisible();
  });

  test('последний открытый таб восстанавливается при повторном открытии', async ({ page }) => {
    await mockConfig(page, null);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettings(page);

    await page.locator('#dlg-tab-notifications').click();
    await expect(page.locator('#dlg-panel-notifications')).toBeVisible();

    await page.locator('.dlg-close').click();
    await page.locator('#btn-settings').click();
    await expect(page.locator('#dlg-panel-notifications')).toBeVisible();
    await expect(page.locator('#dlg-tab-notifications')).toHaveAttribute('aria-selected', 'true');
  });

  test('панель помещается в диалог на узком экране', async ({ page }) => {
    await mockConfig(page, null);
    await page.setViewportSize({ width: 360, height: 800 });
    await openSettings(page);

    const fits = await page.locator('#dlg-panel-provider').evaluate((p) => {
      const dlg = p.closest('dialog').getBoundingClientRect();
      const r = p.getBoundingClientRect();
      return r.right <= dlg.right + 0.5 && r.left >= dlg.left - 0.5;
    });
    expect(fits).toBe(true);

    // Последний таб доступен через горизонтальный скролл таб-бара
    await page.locator('#dlg-tab-aliases').click();
    await expect(page.locator('#dlg-panel-aliases')).toBeVisible();
  });
});
