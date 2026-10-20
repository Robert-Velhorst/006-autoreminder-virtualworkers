import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TestChrome = {
  runtime: { id: string; onInstalled: { addListener: (listener: (...args: unknown[]) => void) => void }; onStartup: { addListener: (listener: (...args: unknown[]) => void) => void }; onMessage: { addListener: (listener: (...args: any[]) => unknown) => void } };
  alarms: { create: ReturnType<typeof vi.fn>; onAlarm: { addListener: (listener: (...args: unknown[]) => void) => void } };
  storage: {
    local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
    onChanged: { addListener: (listener: (changes: Record<string, { oldValue: unknown; newValue: unknown }>, areaName: string) => void) => void };
  };
  permissions: { contains: ReturnType<typeof vi.fn> };
  tabs: { query: ReturnType<typeof vi.fn> };
  action: { setBadgeText: ReturnType<typeof vi.fn>; setBadgeBackgroundColor: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> };
};

function makeChrome(initial: Record<string, unknown>) {
  const state = { ...initial };
  let onMessage: ((...args: any[]) => unknown) | undefined;
  let onAlarm: ((alarm: { name: string }) => void) | undefined;
  let onStorageChanged: ((changes: Record<string, { oldValue: unknown; newValue: unknown }>, areaName: string) => void) | undefined;
  const api: TestChrome = {
    runtime: {
      id: 'test-extension',
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn((listener) => { onMessage = listener; }) },
    },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn((listener) => { onAlarm = listener; }) } },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, state[key]]))),
        set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(state, update); }),
      },
      onChanged: { addListener: vi.fn((listener) => { onStorageChanged = listener; }) },
    },
    permissions: { contains: vi.fn(async () => true) },
    tabs: { query: vi.fn(async () => [{ id: 1, url: 'https://example.test/path', windowId: 1 }]) },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() },
  };

  return {
    api,
    state,
    setEnabled: (enabled: boolean) => {
      const oldValue = state.enabled;
      state.enabled = enabled;
      if (oldValue !== enabled) onStorageChanged?.({ enabled: { oldValue, newValue: enabled } }, 'local');
    },
    setPairing: (updates: Record<string, unknown>) => {
      const changes = Object.fromEntries(Object.entries(updates)
        .filter(([key, value]) => state[key] !== value)
        .map(([key, newValue]) => [key, { oldValue: state[key], newValue }]));
      Object.assign(state, updates);
      if (Object.keys(changes).length) onStorageChanged?.(changes, 'local');
    },
    triggerAlarm: (name = 'report-tabs') => onAlarm?.({ name }),
    report: () => new Promise<Record<string, unknown>>((resolve, reject) => {
      try {
        const accepted = onMessage?.({ type: 'report-now' }, { id: api.runtime.id }, resolve);
        if (accepted !== true) reject(new Error('The collector did not register its report handler'));
      } catch (error) {
        reject(error);
      }
    }),
  };
}

function response(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

const pairedSettings = {
  dashboardUrl: 'https://dashboard.example',
  collectorToken: 'worker-token',
  collectorLabel: 'Worker browser',
  collectorId: 'collector-a',
  captureSequence: 2,
  enabled: true,
};

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('browser collector stale-sequence recovery', () => {
  it('coalesces overlapping alarm and manual events without reusing or duplicating a capture sequence', async () => {
    const chrome = makeChrome(pairedSettings);
    let finishFirstRequest!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<ReturnType<typeof response>>((resolve) => { finishFirstRequest = resolve; }))
      .mockResolvedValueOnce(response({ success: true, staleIgnored: false, storedCaptureSequence: 4, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const firstRun = chrome.report();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    chrome.triggerAlarm();
    const overlappingManualRun = chrome.report();

    finishFirstRequest(response({ success: true, staleIgnored: false, storedCaptureSequence: 3, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }));
    const [firstResult, overlappingResult] = await Promise.all([firstRun, overlappingManualRun]);
    const nextResult = await chrome.report();

    expect(firstResult).toEqual(overlappingResult);
    expect(firstResult.ok).toBe(true);
    expect(nextResult.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sequences = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).captureSequence);
    expect(sequences).toEqual([3, 4]);
  });

  it('rejects a replayed success response for an older capture sequence', async () => {
    const chrome = makeChrome(pairedSettings);
    const fetchMock = vi.fn(async () => response({
      success: true,
      staleIgnored: false,
      storedCaptureSequence: 2,
      shouldWarn: false,
      actionableTabs: 1,
      allowedTabs: 5,
    }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const result = await chrome.report();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/invalid inventory response/i);
  });

  it('rejects a stale response that does not identify a newer stored sequence', async () => {
    const chrome = makeChrome(pairedSettings);
    const fetchMock = vi.fn(async () => response({
      success: true,
      staleIgnored: true,
      storedCaptureSequence: 3,
      shouldWarn: false,
      actionableTabs: 1,
      allowedTabs: 5,
    }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const result = await chrome.report();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/invalid inventory response/i);
  });

  it('resynchronizes and retries a lower-sequence report before reporting success', async () => {
    const chrome = makeChrome(pairedSettings);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, staleIgnored: true, storedCaptureSequence: 7, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }))
      .mockResolvedValueOnce(response({ success: true, staleIgnored: false, storedCaptureSequence: 8, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const result = await chrome.report();

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [requestUrl, init] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe('https://dashboard.example/api/browser-tabs/ingest');
    expect(init.headers.Authorization).toBe('Bearer worker-token');
    expect(init.body).not.toContain('worker-token');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    const sequences = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).captureSequence);
    expect(sequences).toEqual([3, 8]);
  });

  it('bounds repeated stale responses, reports failure, and leaves the next cycle ready to advance', async () => {
    const chrome = makeChrome(pairedSettings);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, staleIgnored: true, storedCaptureSequence: 7, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }))
      .mockResolvedValueOnce(response({ success: true, staleIgnored: true, storedCaptureSequence: 9, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }))
      .mockResolvedValueOnce(response({ success: true, staleIgnored: true, storedCaptureSequence: 11, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }))
      .mockResolvedValueOnce(response({ success: true, staleIgnored: false, storedCaptureSequence: 12, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const firstRun = await chrome.report();
    const nextRun = await chrome.report();

    expect(firstRun.ok).toBe(false);
    expect(firstRun.message).toMatch(/older inventory|stale|sequence/i);
    expect(nextRun.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const sequences = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).captureSequence);
    expect(sequences).toEqual([3, 8, 10, 12]);
  });

  it('does not post if collection is disabled after tab inventory is read but before fetch', async () => {
    const chrome = makeChrome(pairedSettings);
    chrome.api.tabs.query = vi.fn(async () => {
      chrome.setEnabled(false);
      return [{ id: 1, url: 'https://example.test/path', windowId: 1 }];
    });
    const fetchMock = vi.fn(async () => response({ success: true, staleIgnored: false, storedCaptureSequence: 3, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const result = await chrome.report();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/disabled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry a stale inventory after collection is disabled', async () => {
    const chrome = makeChrome(pairedSettings);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          chrome.setEnabled(false);
          chrome.setEnabled(true);
          return { success: true, staleIgnored: true, storedCaptureSequence: 7, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 };
        },
      })
      .mockResolvedValueOnce(response({ success: true, staleIgnored: false, storedCaptureSequence: 3, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const result = await chrome.report();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/disabled/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chrome.state.enabled).toBe(true);
    expect(chrome.state['captureSequence:collector-a']).toBe(3);
  });

  it('does not let an in-flight stale report overwrite a newly saved pairing', async () => {
    const chrome = makeChrome(pairedSettings);
    let finishRequest!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => { finishRequest = resolve; }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const runningReport = chrome.report();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    Object.assign(chrome.state, {
      dashboardUrl: 'https://new-dashboard.example',
      collectorToken: 'new-worker-token',
      collectorId: 'new-collector-id',
      captureSequence: 0,
    });
    finishRequest(response({ success: true, staleIgnored: true, storedCaptureSequence: 900, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }));

    const result = await runningReport;

    expect(result.ok).toBe(false);
    expect(chrome.state).toMatchObject({
      dashboardUrl: 'https://new-dashboard.example',
      collectorToken: 'new-worker-token',
      collectorId: 'new-collector-id',
      captureSequence: 0,
    });
  });

  it('does not let a sequence write overwrite a re-pair that lands after the pairing check', async () => {
    const chrome = makeChrome(pairedSettings);
    const originalSet = chrome.api.storage.local.set;
    let rePaired = false;
    chrome.api.storage.local.set = vi.fn(async (update: Record<string, unknown>) => {
      const isSequenceWrite = Object.keys(update).some((key) => key === 'captureSequence' || key.startsWith('captureSequence:'));
      if (isSequenceWrite && !rePaired) {
        rePaired = true;
        Object.assign(chrome.state, {
          dashboardUrl: 'https://new-dashboard.example',
          collectorToken: 'new-worker-token',
          collectorId: 'new-collector-id',
          captureSequence: 0,
        });
      }
      await originalSet(update);
    });
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', vi.fn());
    await import('../browser-extension/service-worker.js');

    const result = await chrome.report();

    expect(rePaired).toBe(true);
    expect(result.ok).toBe(false);
    expect(chrome.state).toMatchObject({
      dashboardUrl: 'https://new-dashboard.example',
      collectorToken: 'new-worker-token',
      collectorId: 'new-collector-id',
      captureSequence: 0,
    });
    expect(chrome.state['captureSequence:new-collector-id']).toBeUndefined();
  });

  it('marks only the rejected collector for reset on a server conflict', async () => {
    const chrome = makeChrome(pairedSettings);
    const json = vi.fn(async () => ({ success: false }));
    const fetchMock = vi.fn(async () => ({ ok: false, status: 409, json }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const result = await chrome.report();
    const retry = await chrome.report();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/settings.*save.*pairing/i);
    expect(retry.message).toMatch(/settings.*save.*pairing/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chrome.state.collectorId).toBe('collector-a');
    expect(chrome.state.captureSequence).toBe(2);
    expect(chrome.state['collectorResetRequired:collector-a']).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });

  it('does not contact a non-HTTPS remote dashboard origin', async () => {
    const chrome = makeChrome({ ...pairedSettings, dashboardUrl: 'http://attacker.example' });
    const fetchMock = vi.fn();
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const result = await chrome.report();

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.api.permissions.contains).not.toHaveBeenCalled();
    expect(chrome.api.tabs.query).not.toHaveBeenCalled();
    expect(JSON.stringify(chrome.state.lastResult)).not.toContain('worker-token');
  });

  it('rejects malformed stored credentials before collecting tabs or making a request', async () => {
    const chrome = makeChrome({ ...pairedSettings, collectorToken: { value: 'worker-token' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const result = await chrome.report();

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.api.tabs.query).not.toHaveBeenCalled();
    expect(result.message).not.toContain('worker-token');
  });

  it('stores a safe error when the dashboard returns malformed JSON or protocol fields', async () => {
    const chrome = makeChrome(pairedSettings);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad response containing worker-token'); } })
      .mockResolvedValueOnce(response({ success: true, staleIgnored: 'true', storedCaptureSequence: 3, shouldWarn: false, actionableTabs: 1, allowedTabs: 5 }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const malformedJson = await chrome.report();
    const malformedProtocol = await chrome.report();

    expect(malformedJson.ok).toBe(false);
    expect(malformedJson.message).toMatch(/invalid inventory response/i);
    expect(malformedProtocol.ok).toBe(false);
    expect(malformedProtocol.message).toMatch(/invalid inventory response/i);
    expect(JSON.stringify(chrome.state.lastResult)).not.toContain('worker-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight request when the saved pairing changes', async () => {
    const chrome = makeChrome(pairedSettings);
    const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('chrome', chrome.api);
    vi.stubGlobal('fetch', fetchMock);
    await import('../browser-extension/service-worker.js');

    const report = chrome.report();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0][1].signal;
    chrome.setPairing({ dashboardUrl: 'https://new-dashboard.example', collectorToken: 'new-worker-token', collectorId: 'collector-b' });
    const result = await report;

    expect(signal.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/pairing changed/i);
    expect(chrome.state.dashboardUrl).toBe('https://new-dashboard.example');
    expect(chrome.state.collectorId).toBe('collector-b');
  });
});
