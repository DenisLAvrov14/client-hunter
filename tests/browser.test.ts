import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { MAX_BROWSER_LAUNCH_ATTEMPTS, PlaywrightInspector } from '../src/inspect/mobile.js';

/** Minimal stand-in for a Playwright browser: no real Chromium is started in tests. */
function fakeBrowser(opts: { gotoError?: string; html?: string } = {}) {
  const state = { contextsClosed: 0, browserClosed: false };
  const page = {
    on: () => {},
    goto: async () => {
      if (opts.gotoError) throw new Error(opts.gotoError);
    },
    waitForTimeout: async () => {},
    content: async () => opts.html ?? '<html><body><p>rendered</p></body></html>',
    close: async () => {},
  };
  const browser = {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => {
        state.contextsClosed++;
      },
    }),
    close: async () => {
      state.browserClosed = true;
    },
  } as unknown as Browser;
  return { browser, state };
}

function inspectorWith(launches: (() => Promise<Browser>)[]) {
  let calls = 0;
  const inspector = new PlaywrightInspector('TestBot/1', 1000, () => {
    const next = launches[Math.min(calls, launches.length - 1)]!;
    calls++;
    return next();
  });
  return { inspector, launchCalls: () => calls };
}

const failingLaunch = () => Promise.reject(new Error("browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium\nmore details"));

describe('PlaywrightInspector: Chromium failures', () => {
  it('reports a launch failure as an error instead of throwing', async () => {
    const { inspector } = inspectorWith([failingLaunch]);
    expect(await inspector.renderHtml('https://a.co.uk/')).toEqual({
      error: "Chromium failed to launch: browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium",
    });
  });

  it('retries the launch on a later call, up to the limit, then fails fast without launching', async () => {
    const { inspector, launchCalls } = inspectorWith([failingLaunch]);
    for (let i = 0; i < MAX_BROWSER_LAUNCH_ATTEMPTS; i++) await inspector.renderHtml('https://a.co.uk/');
    expect(launchCalls()).toBe(MAX_BROWSER_LAUNCH_ATTEMPTS);

    const after = await inspector.renderHtml('https://a.co.uk/');
    expect(launchCalls()).toBe(MAX_BROWSER_LAUNCH_ATTEMPTS);
    expect(after).toEqual({ error: expect.stringContaining(`unavailable after ${MAX_BROWSER_LAUNCH_ATTEMPTS} launch attempts`) });
  });

  it('a transient launch failure is not cached: the next call launches and renders', async () => {
    const { browser } = fakeBrowser({ html: '<html><body><h1>ok</h1></body></html>' });
    const { inspector, launchCalls } = inspectorWith([failingLaunch, () => Promise.resolve(browser)]);
    expect(await inspector.renderHtml('https://a.co.uk/')).toHaveProperty('error');
    expect(await inspector.renderHtml('https://a.co.uk/')).toEqual({ html: '<html><body><h1>ok</h1></body></html>' });
    expect(launchCalls()).toBe(2);
  });

  it('a rendering error (site timeout) is reported and the browser context is closed', async () => {
    const { browser, state } = fakeBrowser({ gotoError: 'page.goto: Timeout 1000ms exceeded.' });
    const { inspector } = inspectorWith([() => Promise.resolve(browser)]);
    expect(await inspector.renderHtml('https://slow.co.uk/')).toEqual({ error: 'render failed: page.goto: Timeout 1000ms exceeded.' });
    expect(state.contextsClosed).toBe(1);
  });

  it('mobile checks without a browser return failures for every target and no observations', async () => {
    const { inspector } = inspectorWith([failingLaunch]);
    const res = await inspector.inspect(
      [
        { url: 'https://a.co.uk/', kind: 'home' },
        { url: 'https://a.co.uk/contact', kind: 'form' },
      ],
      'unused',
    );
    expect(res.observations).toEqual([]);
    expect(res.failures).toHaveLength(2);
    expect(res.failures[0]).toMatch(/^https:\/\/a\.co\.uk\/: Chromium failed to launch/);
  });

  it('a page that fails to load is a failure, not a silent pass', async () => {
    const { browser } = fakeBrowser({ gotoError: 'net::ERR_NAME_NOT_RESOLVED' });
    const { inspector } = inspectorWith([() => Promise.resolve(browser)]);
    const res = await inspector.inspect([{ url: 'https://gone.co.uk/', kind: 'home' }], 'unused');
    expect(res).toEqual({ observations: [], failures: ['https://gone.co.uk/: net::ERR_NAME_NOT_RESOLVED'] });
  });

  it('close() is safe after a failed launch and closes a launched browser', async () => {
    const failed = inspectorWith([failingLaunch]).inspector;
    await failed.renderHtml('https://a.co.uk/');
    await expect(failed.close()).resolves.toBeUndefined();

    const { browser, state } = fakeBrowser();
    const ok = inspectorWith([() => Promise.resolve(browser)]).inspector;
    await ok.renderHtml('https://a.co.uk/');
    await ok.close();
    expect(state.browserClosed).toBe(true);
  });
});
