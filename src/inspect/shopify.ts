import type { Fetcher } from './fetcher.js';
import type { RobotsPolicy } from './robots.js';

/**
 * Counts products via the public /products.json (spec 7.2): one request, only if robots.txt
 * allows it. Shopify caps a page at 250 items, so the result means "at least N".
 */
export async function countShopifyProducts(
  origin: string,
  fetcher: Fetcher,
  robots: RobotsPolicy,
): Promise<number | null> {
  const url = new URL('/products.json?limit=250', origin).toString();
  if (!robots.isAllowed(url)) return null;
  try {
    const res = await fetcher.fetch(url);
    if (res.status !== 200 || !res.contentType.includes('json')) return null;
    const data = JSON.parse(res.body) as { products?: unknown[] };
    return Array.isArray(data.products) ? data.products.length : null;
  } catch {
    return null;
  }
}
