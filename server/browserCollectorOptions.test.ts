import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeElement(value: Record<string, unknown> = {}) {
  const listeners: Record<string, (...args: any[]) => unknown> = {};
  return {
    ...value,
    value: value.value ?? '',
    checked: value.checked ?? false,
    textContent: '',
    className: '',
    listeners,
    addEventListener: vi.fn((event: string, listener: (...args: any[]) => unknown) => { listeners[event] = listener; }),
    reportValidity: vi.fn(() => true),
  };
}

function makeOptionsPage(initial: Record<string, unknown>) {
  const state = { ...initial };
  const elements = {
    '#settings-form': makeElement(),
    '#dashboard-url': makeElement({ value: 'https://new-dashboard.example' }),
    '#collector-label': makeElement({ value: 'Worker browser' }),
    '#collector-token': makeElement({ value: 'new-worker-token' }),
    '#enabled': makeElement({ checked: true }),
    '#status': makeElement(),
    '#test': makeElement(),
  };
  const chrome = {
    storage: { local: {
      get: vi.fn(async (keys: string[] | Record<string, unknown>) => Array.isArray(keys)
        ? Object.fromEntries(keys.map((key) => [key, state[key]]))
        : { ...keys, ...state }),
      set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(state, update); }),
    } },
    permissions: {
      request: vi.fn(async () => true),
      contains: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    },
    action: { setBadgeText: vi.fn() },
  };
  return {
    state,
    chrome,
    elements,
    document: { querySelector: (selector: string) => elements[selector as keyof typeof elements] },
  };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('browser collector re-pairing', () => {
  it('revokes the previous dashboard host permission after saving a different dashboard', async () => {
    const page = makeOptionsPage({
      dashboardUrl: 'https://old-dashboard.example',
      collectorToken: 'old-worker-token',
      collectorLabel: 'Worker browser',
      collectorId: 'stale-collector-id',
      captureSequence: 987,
      enabled: true,
    });
    vi.stubGlobal('chrome', page.chrome);
    vi.stubGlobal('document', page.document);
    vi.stubGlobal('crypto', { randomUUID: () => 'fresh-collector-id' });
    await import('../browser-extension/options.js');
    page.elements['#dashboard-url'].value = 'https://new-dashboard.example';
    page.elements['#collector-token'].value = 'new-worker-token';

    await page.elements['#settings-form'].listeners.submit({ preventDefault: vi.fn() });

    expect(page.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(page.chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://new-dashboard.example/*'] });
    expect(page.chrome.permissions.remove).toHaveBeenCalledWith({ origins: ['https://old-dashboard.example/*'] });
    expect(page.chrome.storage.local.set.mock.invocationCallOrder[0])
      .toBeLessThan(page.chrome.permissions.remove.mock.invocationCallOrder[0]);
  });

  it('rotates collector identity and resets the sequence when dashboard credentials change', async () => {
    const page = makeOptionsPage({
      dashboardUrl: 'https://old-dashboard.example',
      collectorToken: 'old-worker-token',
      collectorLabel: 'Worker browser',
      collectorId: 'stale-collector-id',
      captureSequence: 987,
      enabled: false,
    });
    vi.stubGlobal('chrome', page.chrome);
    vi.stubGlobal('document', page.document);
    vi.stubGlobal('crypto', { randomUUID: () => 'fresh-collector-id' });
    await import('../browser-extension/options.js');
    page.elements['#dashboard-url'].value = 'https://new-dashboard.example';
    page.elements['#collector-token'].value = 'new-worker-token';

    await page.elements['#settings-form'].listeners.submit({ preventDefault: vi.fn() });

    expect(page.state).toMatchObject({
      dashboardUrl: 'https://new-dashboard.example',
      collectorToken: 'new-worker-token',
      collectorId: 'fresh-collector-id',
      captureSequence: 0,
    });
  });

  it('preserves sequence when saving unchanged pairing details', async () => {
    const page = makeOptionsPage({
      dashboardUrl: 'https://new-dashboard.example',
      collectorToken: 'new-worker-token',
      collectorLabel: 'Worker browser',
      collectorId: 'current-collector-id',
      captureSequence: 42,
      enabled: false,
    });
    vi.stubGlobal('chrome', page.chrome);
    vi.stubGlobal('document', page.document);
    vi.stubGlobal('crypto', { randomUUID: () => 'should-not-be-used' });
    await import('../browser-extension/options.js');

    await page.elements['#settings-form'].listeners.submit({ preventDefault: vi.fn() });

    expect(page.state.collectorId).toBe('current-collector-id');
    expect(page.state.captureSequence).toBe(42);
  });

  it('rotates identity when the current collector was marked for reset', async () => {
    const page = makeOptionsPage({
      dashboardUrl: 'https://new-dashboard.example',
      collectorToken: 'new-worker-token',
      collectorLabel: 'Worker browser',
      collectorId: 'rejected-collector-id',
      captureSequence: 42,
      'captureSequence:rejected-collector-id': 43,
      'collectorResetRequired:rejected-collector-id': true,
      enabled: false,
    });
    vi.stubGlobal('chrome', page.chrome);
    vi.stubGlobal('document', page.document);
    vi.stubGlobal('crypto', { randomUUID: () => 'fresh-collector-id' });
    await import('../browser-extension/options.js');

    await page.elements['#settings-form'].listeners.submit({ preventDefault: vi.fn() });

    expect(page.state.collectorId).toBe('fresh-collector-id');
    expect(page.state.captureSequence).toBe(0);
    expect(page.state['captureSequence:fresh-collector-id']).toBe(0);
    expect(page.state['collectorResetRequired:fresh-collector-id']).toBe(false);
  });

  it('rejects blank credentials and labels before requesting origin permission', async () => {
    const page = makeOptionsPage({
      dashboardUrl: 'https://old-dashboard.example',
      collectorToken: 'old-worker-token',
      collectorLabel: 'Worker browser',
      collectorId: 'current-collector-id',
      captureSequence: 42,
      enabled: true,
    });
    vi.stubGlobal('chrome', page.chrome);
    vi.stubGlobal('document', page.document);
    await import('../browser-extension/options.js');

    page.elements['#collector-token'].value = '   ';
    await page.elements['#settings-form'].listeners.submit({ preventDefault: vi.fn() });
    expect(page.chrome.permissions.request).not.toHaveBeenCalled();
    expect(page.chrome.storage.local.set).not.toHaveBeenCalled();
    expect(page.elements['#status'].textContent).toMatch(/collector token/i);

    page.elements['#collector-token'].value = 'new-worker-token';
    page.elements['#collector-label'].value = '   ';
    await page.elements['#settings-form'].listeners.submit({ preventDefault: vi.fn() });
    expect(page.chrome.permissions.request).not.toHaveBeenCalled();
    expect(page.chrome.storage.local.set).not.toHaveBeenCalled();
    expect(page.elements['#status'].textContent).toMatch(/collector label/i);
  });

  it('rotates malformed saved collector IDs without reading their derived storage keys', async () => {
    const page = makeOptionsPage({
      dashboardUrl: 'https://new-dashboard.example',
      collectorToken: 'new-worker-token',
      collectorLabel: 'Worker browser',
      collectorId: 'bad/id',
      captureSequence: 42,
      enabled: false,
    });
    vi.stubGlobal('chrome', page.chrome);
    vi.stubGlobal('document', page.document);
    vi.stubGlobal('crypto', { randomUUID: () => 'fresh-collector-id' });
    await import('../browser-extension/options.js');

    await page.elements['#settings-form'].listeners.submit({ preventDefault: vi.fn() });

    expect(page.state.collectorId).toBe('fresh-collector-id');
    expect(page.chrome.storage.local.get).toHaveBeenCalledTimes(2);
    expect(page.chrome.storage.local.get).toHaveBeenNthCalledWith(1, { dashboardUrl: '', collectorLabel: 'Worker browser', collectorToken: '', enabled: false });
    expect(page.chrome.storage.local.get).toHaveBeenNthCalledWith(2, ['dashboardUrl', 'collectorToken', 'collectorId', 'captureSequence']);
  });
});
