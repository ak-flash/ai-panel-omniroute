import { test, expect } from '@playwright/test';
import { configResponse, mockCombos, waitForBoot } from './mock-api.js';

const ORDER_KEY = 'aipanel.provider-card-order.v1';
const DEFAULT_ORDER = [
  'cards',
  'selora-card',
  'antigravity-quota',
  'ar-card',
  'experiential-card',
  'or-card',
];
const PROVIDERS = ['xkiro', 'selora', 'agentrouter', 'experiential', 'openrouter'];
const USAGE = {
  plan: 'pro',
  wallet: { balance_usd: 82.31, held_usd: 0 },
  today_usd: 2.5,
  windows: [
    { kind: 'short', spent_usd: 1, cap_usd: 10, window_sec: 14400, resets_in_sec: 3600 },
    { kind: 'long', spent_usd: 5, cap_usd: 100, window_sec: 604800, resets_in_sec: 86400 },
  ],
};

async function mockDashboard(page, hidden = []) {
  const config = configResponse({
    hasSeloraKey: !hidden.includes('selora'),
    hasAgentrouterKey: !hidden.includes('agentrouter'),
    hasExperientialKey: !hidden.includes('experiential'),
    hasOpenrouterKey: !hidden.includes('openrouter'),
    providers: PROVIDERS.map(id => ({ id, name: id, hasKey: !hidden.includes(id) })),
  });
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const body =
      pathname === '/api/config'
        ? config
        : pathname.endsWith('/usage')
          ? USAGE
          : pathname === '/api/antigravity-quota'
            ? hidden.includes('antigravity')
              ? { error: 'no_token' }
              : {
                  models: [
                    { id: 'claude-sonnet', displayName: 'Claude Sonnet', remainingFraction: 0.8 },
                  ],
                }
            : {};
    return route.fulfill({
      status: pathname === '/api/antigravity-quota' && hidden.includes('antigravity') ? 401 : 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await mockCombos(page, []);
}

async function openDashboard(page, visibleCount = 6) {
  await page.goto('/');
  await waitForBoot(page);
  await expect(page.locator('#provider-cards > .provider-card:not([hidden])')).toHaveCount(
    visibleCount
  );
  await expect(page.locator('#wallet-balance')).toHaveText('$82.31');
}

function cardOrder(page) {
  return page
    .locator('#provider-cards > .provider-card')
    .evaluateAll(cards => cards.map(card => card.id));
}

function savedOrder(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), ORDER_KEY);
}

async function expectOrder(page, order) {
  await expect.poll(() => cardOrder(page)).toEqual(order);
}

async function startMouseDrag(page, sourceId, targetId, after = false) {
  const handle = page.locator(`#${sourceId} .provider-drag-handle`);
  await handle.scrollIntoViewIfNeeded();
  const source = await handle.boundingBox();
  const target = await page.locator('#' + targetId).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + (after ? target.height - 20 : 20), {
    steps: 8,
  });
  await expect(page.locator('.provider-sort-preview')).toBeVisible();
}

test.describe('Главная: сортировка карточек провайдеров', () => {
  test.use({ viewport: { width: 1280, height: 1100 } });

  test.beforeEach(async ({ page }) => {
    await mockDashboard(page);
  });

  test('перетаскивает карточку между рядами и сохраняет порядок после перезагрузки', async ({
    page,
  }) => {
    await openDashboard(page);
    await startMouseDrag(page, 'or-card', 'cards');
    await expect(page.locator('#cards')).toHaveAttribute('data-sort-drop', 'top');
    await page.mouse.up();

    const order = ['or-card', ...DEFAULT_ORDER.filter(id => id !== 'or-card')];
    await expectOrder(page, order);
    expect(await savedOrder(page)).toEqual(order);
    await expect(page.locator('#or-card .provider-drag-handle')).toBeFocused();
    await expect(page.locator('#provider-sort-status')).toContainText('позиция 1 из 6');
    await expect(page.locator('.provider-sort-preview')).toHaveCount(0);
    await expect(page.locator('[data-sort-drop]')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveClass(/is-provider-sorting/);

    await page.reload();
    await waitForBoot(page);
    await expectOrder(page, order);
    await expect(page.locator('#or-card')).toBeVisible();
  });

  test('переставляет карточки в одном ряду слева направо', async ({ page }) => {
    await openDashboard(page);
    const target = await page.locator('#or-card').boundingBox();
    await page.locator('#ar-card .provider-drag-handle').dragTo(page.locator('#or-card'), {
      targetPosition: { x: target.width - 20, y: 20 },
    });
    await expectOrder(page, [
      'cards',
      'selora-card',
      'antigravity-quota',
      'experiential-card',
      'or-card',
      'ar-card',
    ]);
  });

  test('стрелки, Home и End меняют порядок и сохраняют фокус', async ({ page }) => {
    await openDashboard(page);
    const handle = page.locator('#selora-card .provider-drag-handle');
    await expect(handle).toHaveAttribute('aria-describedby', 'provider-sort-hint');
    await expect(handle).toHaveAttribute('aria-label', 'Переместить карточку Selora');
    await handle.focus();
    await handle.press('ArrowUp');
    await expectOrder(page, ['selora-card', 'cards', ...DEFAULT_ORDER.slice(2)]);
    await expect(handle).toBeFocused();
    await expect(page.locator('#provider-sort-status')).toContainText('Selora, позиция 1 из 6');

    await handle.press('ArrowLeft');
    await expectOrder(page, ['selora-card', 'cards', ...DEFAULT_ORDER.slice(2)]);
    await handle.press('ArrowRight');
    await expectOrder(page, DEFAULT_ORDER);
    await handle.press('End');
    const last = [...DEFAULT_ORDER.filter(id => id !== 'selora-card'), 'selora-card'];
    await expectOrder(page, last);
    await handle.press('ArrowDown');
    await expectOrder(page, last);
    await handle.press('Home');
    const first = ['selora-card', ...DEFAULT_ORDER.filter(id => id !== 'selora-card')];
    await expectOrder(page, first);
    expect(await savedOrder(page)).toEqual(first);
    await expect(handle).toBeFocused();
  });

  test('обновление данных и раскрытые группы не сбрасываются при перестановке', async ({
    page,
  }) => {
    await openDashboard(page);
    const group = page.locator('#antigravity-quota .ag-group-head');
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#antigravity-quota .provider-drag-handle').press('Home');
    const order = ['antigravity-quota', ...DEFAULT_ORDER.filter(id => id !== 'antigravity-quota')];
    await expectOrder(page, order);
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#ag-cards .stat-label')).toHaveText('Claude Sonnet');
    await expect(page.locator('#wallet-balance')).toHaveText('$82.31');

    await page.locator('#btn-refresh').click();
    await expectOrder(page, order);
    expect(await savedOrder(page)).toEqual(order);
  });

  test('восстанавливает известные ID без дублей и добавляет новые карточки', async ({ page }) => {
    await page.addInitScript(
      ({ key }) => {
        localStorage.setItem(
          key,
          JSON.stringify(['or-card', 'obsolete', 'or-card', null, 'selora-card'])
        );
      },
      { key: ORDER_KEY }
    );
    await openDashboard(page);
    await expectOrder(page, [
      'or-card',
      'selora-card',
      'cards',
      'antigravity-quota',
      'ar-card',
      'experiential-card',
    ]);
    await expect(page.locator('.provider-drag-handle')).toHaveCount(6);
  });

  test('повреждённая настройка не мешает загрузке и новой сортировке', async ({ page }) => {
    await page.addInitScript(key => localStorage.setItem(key, '{broken json'), ORDER_KEY);
    await openDashboard(page);
    await expectOrder(page, DEFAULT_ORDER);
    await page.locator('#or-card .provider-drag-handle').press('Home');
    expect(await savedOrder(page)).toEqual([
      'or-card',
      ...DEFAULT_ORDER.filter(id => id !== 'or-card'),
    ]);
  });

  test('сохраняет скрытые карточки и возвращает их на прежние места', async ({ page }) => {
    await mockDashboard(page, ['agentrouter', 'antigravity']);
    await openDashboard(page, 4);
    await page.locator('#or-card .provider-drag-handle').press('Home');
    const order = ['or-card', ...DEFAULT_ORDER.filter(id => id !== 'or-card')];
    await expectOrder(page, order);
    expect(await savedOrder(page)).toEqual(order);
    await expect(page.locator('#ar-card')).toBeHidden();
    await expect(page.locator('#antigravity-quota')).toBeHidden();

    await mockDashboard(page);
    await openDashboard(page);
    await expectOrder(page, order);
    await expect(page.locator('#ar-card')).toBeVisible();
    await expect(page.locator('#antigravity-quota')).toBeVisible();
  });

  test('Escape отменяет перетаскивание без сохранения', async ({ page }) => {
    await openDashboard(page);
    await startMouseDrag(page, 'or-card', 'cards');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expectOrder(page, DEFAULT_ORDER);
    expect(await savedOrder(page)).toBeNull();
    await expect(page.locator('#provider-sort-status')).toHaveText('Перемещение отменено.');
    await expect(
      page.locator('.provider-sort-preview, [data-sort-drop], .provider-card.is-sorting')
    ).toHaveCount(0);
  });

  test('клик и перетаскивание за содержимое карточки не меняют порядок', async ({ page }) => {
    await openDashboard(page);
    await page.locator('#or-card .provider-drag-handle').click();
    await page.locator('#ar-balance').dragTo(page.locator('#cards'));
    await expectOrder(page, DEFAULT_ORDER);
    expect(await savedOrder(page)).toBeNull();
    await expect(page.locator('.provider-sort-preview')).toHaveCount(0);
  });

  test('сортировка работает без localStorage и предупреждает о несохранённом порядке', async ({
    page,
  }) => {
    await page.addInitScript(key => {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (name) {
        if (name === key) throw new DOMException('Blocked', 'SecurityError');
        return get.call(this, name);
      };
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Blocked', 'SecurityError');
        return set.call(this, name, value);
      };
    }, ORDER_KEY);
    await openDashboard(page);
    await page.locator('#or-card .provider-drag-handle').press('Home');
    await expectOrder(page, ['or-card', ...DEFAULT_ORDER.filter(id => id !== 'or-card')]);
    await expect(page.locator('.toast-error')).toContainText(
      'Не удалось сохранить порядок карточек'
    );
    await page.locator('#or-card .provider-drag-handle').press('End');
    await expectOrder(page, DEFAULT_ORDER);
    await expect(page.locator('.toast-error')).toHaveCount(1);
  });
});

test.describe('Главная: сортировка на сенсорном экране', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page }) => {
    await mockDashboard(page);
    await openDashboard(page);
  });

  async function touchStart(page) {
    const handle = await page.locator('#cards .provider-drag-handle').boundingBox();
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }],
    });
    return client;
  }

  test('перетаскивает карточку пальцем и прокручивает страницу к последней позиции', async ({
    page,
  }) => {
    const client = await touchStart(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 195, y: 824 }],
    });
    await expect(page.locator('.provider-sort-preview')).toBeVisible();
    const maxScroll = await page.evaluate(
      () => document.documentElement.scrollHeight - innerHeight
    );
    expect(maxScroll).toBeGreaterThan(200);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(maxScroll);
    await expect(page.locator('#or-card')).toHaveAttribute('data-sort-drop', 'bottom');
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const order = [...DEFAULT_ORDER.slice(1), 'cards'];
    await expectOrder(page, order);
    expect(await savedOrder(page)).toEqual(order);
    await expect(page.locator('.provider-sort-preview')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await client.detach();
  });

  test('touchcancel очищает состояние перетаскивания без изменения порядка', async ({ page }) => {
    const client = await touchStart(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 195, y: 500 }],
    });
    await expect(page.locator('.provider-sort-preview')).toBeVisible();
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expectOrder(page, DEFAULT_ORDER);
    expect(await savedOrder(page)).toBeNull();
    await expect(
      page.locator('.provider-sort-preview, [data-sort-drop], .provider-card.is-sorting')
    ).toHaveCount(0);
    await client.detach();
  });
});
