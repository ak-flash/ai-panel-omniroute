import { expect } from '@playwright/test';

// Общие ответы API для браузерных сценариев: страницы не должны ходить
// в реальные провайдеры. Каждый сценарий подменяет только нужные пути
// через page.route — остальное уходит на локальный сервер панели.
export const PROVIDERS = [
  { id: 'xkiro', name: 'xKiro', site: 'https://xkiro.com/dashboard', hasKey: true },
  { id: 'openrouter', name: 'OpenRouter', site: 'https://openrouter.ai', hasKey: true },
  { id: 'agentrouter', name: 'AgentRouter', site: 'https://agentrouter.org', hasKey: false },
];

export function configResponse(overrides = {}) {
  return {
    ok: true,
    data: {
      hasXkiroKey: true,
      hasOpenrouterKey: true,
      hasAgentrouterKey: false,
      comboDisabled: '',
      ...overrides,
    },
    providers: PROVIDERS,
    activeProvider: 'xkiro',
    ...overrides,
  };
}

export const XKIRO_USAGE = {
  plan: 'pro',
  wallet: { balance_usd: 82.31, held_usd: 0 },
  windows: [{ name: '5h', used: 12, limit: 100, resets_in: 3600 }],
  free_tokens: null,
};

export const XKIRO_MODELS = {
  data: [
    {
      id: 'gpt-4o',
      display_name: 'GPT-4o',
      access_tier: 'paid',
      context_length: 128000,
      pricing: { input: 2.5, output: 10 },
    },
    {
      id: 'gpt-4o-mini',
      display_name: 'GPT-4o mini',
      access_tier: 'free',
      context_length: 128000,
      pricing: { input: 0.15, output: 0.6 },
    },
    {
      id: 'claude-sonnet',
      display_name: 'Claude Sonnet',
      access_tier: 'paid',
      context_length: 200000,
      pricing: { input: null, output: null },
    },
  ],
};

/** Подменяет /api/config и /api/providers/<id>/{usage,models}. */
export async function mockProviders(page, { usage, models, config } = {}) {
  await page.route('**/api/config', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(config || configResponse()),
    })
  );
  await page.route('**/api/providers/xkiro/usage', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(usage || XKIRO_USAGE),
    })
  );
  await page.route('**/api/providers/xkiro/models', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(models || XKIRO_MODELS),
    })
  );
}

/** Пустой рейтинг для кодинга: страница не должна требовать ключ OpenRouter. */
export async function mockCodingRatings(page) {
  await page.route('**/api/coding-ratings', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ source: 'none', updatedAt: null, ratings: {} }),
    })
  );
}

/** Список combo + детали первой: путь страницы Combo. */
export async function mockCombos(page, combos = []) {
  // В Playwright последний зарегистрированный route побеждает, поэтому
  // catch-all ставим первым, иначе он перехватывает и /api/combos.
  await page.route('**/omniroute/api/**', route =>
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
    await page.route('**/omniroute/api/combos/' + combo.id, route =>
      // Детали combo — сам объект, без обёртки: страница читает models
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(combo),
      })
    );
  }
}

/** Ждёт, пока панель снимет класс is-booting (страница готова к работе). */
export async function waitForBoot(page) {
  await expect(page.locator('body')).not.toHaveClass(/is-booting/);
}
