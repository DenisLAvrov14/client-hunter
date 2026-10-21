import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ObservationDraft } from './types.js';

export interface MobileTarget {
  url: string;
  kind: 'home' | 'form';
}

export interface MobileInspector {
  inspect(targets: MobileTarget[], screenshotDir: string): Promise<ObservationDraft[]>;
  close(): Promise<void>;
}

const VIEWPORT = { width: 390, height: 844 };

/** Playwright-based checks (spec 8.1 step 5): one browser, a fresh context per site, never submits anything. */
export class PlaywrightInspector implements MobileInspector {
  private browser: Browser | null = null;

  constructor(
    private readonly userAgent: string,
    private readonly timeoutMs: number,
  ) {}

  private async context(): Promise<BrowserContext> {
    this.browser ??= await chromium.launch({ headless: true });
    return this.browser.newContext({
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

  async inspect(targets: MobileTarget[], screenshotDir: string): Promise<ObservationDraft[]> {
    const ctx = await this.context();
    const found: ObservationDraft[] = [];
    try {
      for (const target of targets) {
        const page = await ctx.newPage();
        const jsErrors: string[] = [];
        page.on('pageerror', (err) => jsErrors.push(err.message.slice(0, 200)));
        try {
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
        } catch {
          // Browser failures on one page are not observations; the HTML checks still stand.
        } finally {
          await page.close();
        }
      }
    } finally {
      await ctx.close();
    }
    return found;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
