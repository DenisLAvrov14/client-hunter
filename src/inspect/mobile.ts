import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ObservationDraft } from './types.js';

export interface MobileTarget {
  url: string;
  kind: 'home' | 'form';
}

/** `failures` lists targets the browser could not check — they are NOT "checked, nothing found". */
export interface MobileResult {
  observations: ObservationDraft[];
  failures: string[];
}

export interface MobileInspector {
  inspect(targets: MobileTarget[], screenshotDir: string): Promise<MobileResult>;
  close(): Promise<void>;
}

export type RenderResult = { html: string } | { error: string };

/** Renders a page with JavaScript, for sites whose server HTML has almost no text. */
export interface PageRenderer {
  renderHtml(url: string): Promise<RenderResult>;
  close(): Promise<void>;
}

/** Chromium launch attempts per run; after that the browser is reported unavailable without retrying. */
export const MAX_BROWSER_LAUNCH_ATTEMPTS = 2;

export class BrowserUnavailableError extends Error {}

const VIEWPORT = { width: 390, height: 844 };

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 200);

/** Playwright-based checks (spec 8.1 step 5): one browser, a fresh context per site, never submits anything. */
export class PlaywrightInspector implements MobileInspector, PageRenderer {
  // The launch promise, not the browser, is cached so concurrent sites share one Chromium.
  private browser: Promise<Browser> | null = null;
  private launchFailures = 0;
  private lastLaunchError = '';

  constructor(
    private readonly userAgent: string,
    private readonly timeoutMs: number,
    private readonly launch: () => Promise<Browser> = () => chromium.launch({ headless: true }),
  ) {}

  /** A failed launch is forgotten so a later call can retry, up to MAX_BROWSER_LAUNCH_ATTEMPTS per run. */
  private async context(): Promise<BrowserContext> {
    if (!this.browser) {
      if (this.launchFailures >= MAX_BROWSER_LAUNCH_ATTEMPTS) {
        throw new BrowserUnavailableError(
          `Chromium unavailable after ${this.launchFailures} launch attempts: ${this.lastLaunchError}`,
        );
      }
      const launching = this.launch();
      this.browser = launching;
      launching.catch((err) => {
        if (this.browser === launching) this.browser = null;
        this.launchFailures++;
        this.lastLaunchError = firstLine(err);
      });
    }
    let browser: Browser;
    try {
      browser = await this.browser;
    } catch (err) {
      throw new BrowserUnavailableError(`Chromium failed to launch: ${firstLine(err)}`);
    }
    return browser.newContext({
      viewport: VIEWPORT,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      userAgent: `${this.userAgent} Mobile`,
      acceptDownloads: false,
      permissions: [],
      serviceWorkers: 'block',
    });
  }

  async inspect(targets: MobileTarget[], screenshotDir: string): Promise<MobileResult> {
    let ctx: BrowserContext;
    try {
      ctx = await this.context();
    } catch (err) {
      return { observations: [], failures: targets.map((t) => `${t.url}: ${firstLine(err)}`) };
    }
    const found: ObservationDraft[] = [];
    const failures: string[] = [];
    try {
      for (const target of targets) {
        let page: Awaited<ReturnType<BrowserContext['newPage']>> | null = null;
        const jsErrors: string[] = [];
        try {
          page = await ctx.newPage();
          page.on('pageerror', (err) => jsErrors.push(err.message.slice(0, 200)));
          await page.goto(target.url, { waitUntil: 'load', timeout: this.timeoutMs });
          await page.waitForTimeout(1500);

          if (target.kind === 'form') {
            if (jsErrors.length > 0) {
              found.push({
                code: 'FORM_JS_ERROR',
                status: 'likely',
                description: `JavaScript errors on a page with a form (${jsErrors.length})`,
                evidenceUrl: target.url,
                evidenceDetail: jsErrors.slice(0, 3).join('\n'),
              });
            }
            continue;
          }

          mkdirSync(screenshotDir, { recursive: true });

          // MOBILE_OVERFLOW: content wider than the viewport AND the page actually scrolls sideways.
          const overflow = await page.evaluate(() => {
            const scrollWidth = document.documentElement.scrollWidth;
            const innerWidth = window.innerWidth;
            window.scrollTo(200, 0);
            const scrolled = window.scrollX;
            window.scrollTo(0, 0);
            return { scrollWidth, innerWidth, scrolled };
          });
          if (overflow.scrollWidth > overflow.innerWidth + 5 && overflow.scrolled > 0) {
            const shot = path.join(screenshotDir, 'mobile-overflow.png');
            await page.screenshot({ path: shot });
            found.push({
              code: 'MOBILE_OVERFLOW',
              status: 'verified',
              description: `On a 390px-wide phone screen the page is ${overflow.scrollWidth}px wide and scrolls sideways`,
              evidenceUrl: target.url,
              evidenceDetail: `scrollWidth=${overflow.scrollWidth} innerWidth=${overflow.innerWidth}`,
              screenshotPath: shot,
            });
          }

          // SMALL_TAP_TARGETS: share of interactive elements in the first screen smaller than 32x32 CSS px.
          const taps = await page.evaluate((vh) => {
            const els = [...document.querySelectorAll('a[href], button, input, select, [role="button"]')];
            let total = 0;
            let small = 0;
            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh) continue;
              total++;
              if (r.width < 32 || r.height < 32) small++;
            }
            return { total, small };
          }, VIEWPORT.height);
          if (taps.total >= 5 && taps.small / taps.total >= 0.4) {
            found.push({
              code: 'SMALL_TAP_TARGETS',
              status: 'likely',
              description: `${taps.small} of ${taps.total} tappable elements on the first phone screen are smaller than 32×32px`,
              evidenceUrl: target.url,
              evidenceDetail: `${taps.small}/${taps.total}`,
            });
          }

          // BROKEN_IMAGES: scroll through to trigger lazy loading, then look for images that loaded with no pixels.
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight && y < 20000; y += 800) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 150));
            }
            window.scrollTo(0, 0);
          });
          await page.waitForTimeout(1500);
          const broken = await page.evaluate(() =>
            [...document.images]
              .filter((img) => img.complete && img.naturalWidth === 0 && !!img.currentSrc && !img.currentSrc.startsWith('data:'))
              .map((img) => img.currentSrc)
              .slice(0, 10),
          );
          if (broken.length > 0) {
            // Only a suspicion: lazy-loaders and tracking pixels also report naturalWidth 0.
            // processCompany confirms each URL over HTTP before this becomes `verified`.
            const shot = path.join(screenshotDir, 'broken-images.png');
            await page.evaluate((src) => {
              const img = [...document.images].find((i) => i.currentSrc === src);
              img?.scrollIntoView({ block: 'center' });
            }, broken[0]!);
            await page.screenshot({ path: shot, fullPage: false });
            found.push({
              code: 'BROKEN_IMAGES',
              status: 'unknown',
              description: `${broken.length} image(s) on the home page did not render`,
              evidenceUrl: target.url,
              evidenceDetail: [...new Set(broken)].join('\n'),
              screenshotPath: shot,
            });
          }
        } catch (err) {
          // Not an observation and not a pass: the page was not checked. HTML checks still stand.
          failures.push(`${target.url}: ${firstLine(err)}`);
        } finally {
          await page?.close().catch(() => {});
        }
      }
    } finally {
      await ctx.close().catch(() => {});
    }
    return { observations: found, failures };
  }

  /** Page HTML after JavaScript has run, or the reason it could not be rendered. Never submits or clicks anything. */
  async renderHtml(url: string): Promise<RenderResult> {
    let ctx: BrowserContext;
    try {
      ctx = await this.context();
    } catch (err) {
      return { error: firstLine(err) };
    }
    try {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: this.timeoutMs });
      await page.waitForTimeout(2000);
      return { html: await page.content() };
    } catch (err) {
      return { error: `render failed: ${firstLine(err)}` };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;
    try {
      await (await browser).close();
    } catch {
      // A browser that never launched has nothing to close.
    }
  }
}
