// Public forum feeds where business owners post (config/intent.yaml → sources.forums): RSS 2.0
// feeds of XenForo / Invision forums (title, date, author and the opening post in one request) and
// Discourse categories (public /c/…json lists and /t/<id>.json topics). robots.txt is checked by the
// caller; no login, no search endpoints, no posting.
import type { ForumFeedConfig } from '../../config/schema.js';
import type { Fetcher } from '../../inspect/fetcher.js';
import { decodeEntities } from '../text.js';
import type { RawRequest } from '../types.js';

const TEXT_CHARS = 4000;

async function json(fetcher: Fetcher, url: string): Promise<string> {
  const res = await fetcher.fetch(url, { accept: 'application/json' });
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  if (res.truncated) throw new Error(`${url}: response larger than the size limit`);
  return res.body;
}

/** Forum HTML (XenForo bbWrapper, Discourse cooked) to plain lines; quotes of other posts dropped. */
export function forumHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
      .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, '')
      .replace(/<br\s*\/?>|<\/(?:p|div|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const tag = (item: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(item);
  if (!m) return null;
  const v = m[1]!.trim();
  return v.startsWith('<![CDATA[') ? v.slice(9, v.lastIndexOf(']]>')) : decodeEntities(v);
};

/**
 * One request per feed item (a thread and its opening post). XenForo and Invision feeds are ordered
 * by activity and their pubDate can be the LAST reply (a 2025 thread bumped last week): the date is
 * kept as `dateIsActivity` until threadStartDate() confirms when the thread was started. Items
 * without activity since `since` are dropped.
 */
export function parseRss(xml: string, feed: Pick<ForumFeedConfig, 'id' | 'label' | 'reply'>, since: Date): RawRequest[] {
  const out: RawRequest[] = [];
  for (const item of xml.split(/<item[\s>]/i).slice(1)) {
    const title = tag(item, 'title');
    const link = tag(item, 'link');
    const date = tag(item, 'pubDate');
    if (!title || !link || !date) continue;
    const activity = new Date(date);
    if (Number.isNaN(activity.getTime()) || activity < since) continue;
    // Invision links to the latest comment ("?do=findComment&comment=…"): the request is the topic itself.
    const url = link.replace(/\?do=findComment.*$/, '');
    const guid = tag(item, 'guid');
    const comments = tag(item, 'slash:comments');
    out.push({
      source: feed.id,
      itemId: guid?.replace(/^urn:xenforo:thread:/, '') ?? url,
      url,
      publishedAt: activity.toISOString(),
      dateIsActivity: true,
      ...(feed.reply ? { replyHint: feed.reply } : {}),
      author: tag(item, 'dc:creator') ?? tag(item, 'author')?.replace(/^.*\((.*)\)$/, '$1') ?? null,
      organisation: null,
      title: decodeEntities(title).trim(),
      text: forumHtmlToText(tag(item, 'content:encoded') ?? tag(item, 'description') ?? '').slice(0, TEXT_CHARS),
      header: decodeEntities(title).trim(),
      context: feed.label,
      replies: comments !== null && /^\d+$/.test(comments) ? Number(comments) : null,
    });
  }
  return out;
}

/**
 * When the thread was started: the first <time datetime> of a XenForo / Invision thread page is the
 * thread's start date ("Start date" in XenForo, the opening post in Invision). Null if not found.
 */
export function threadStartFromHtml(html: string): string | null {
  const m = /<time[^>]*\sdatetime=['"]([^'"]+)['"]/i.exec(html);
  const d = m ? new Date(m[1]!.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

export async function threadStartDate(fetcher: Fetcher, url: string): Promise<string | null> {
  const res = await fetcher.fetch(url);
  return res.status === 200 ? threadStartFromHtml(res.body) : null;
}

interface DiscourseTopic {
  id: number;
  slug: string;
  title: string;
  created_at: string;
  bumped_at: string;
  posts_count: number;
  closed?: boolean;
}
interface DiscourseList {
  topic_list: { topics: DiscourseTopic[]; more_topics_url?: string };
}
interface DiscourseTopicJson {
  title: string;
  created_at: string;
  post_stream: { posts: { username: string; cooked: string }[] };
}

/**
 * Topics created since `since` in the configured Discourse categories. Busy merchant categories are
 * mostly support questions: there only topics whose title passes `titleLooksLikeRequest` are read.
 * Discourse "closed" means replies are off (moderators close job posts), not that the work is filled.
 */
export async function fetchDiscourse(
  fetcher: Fetcher,
  feed: ForumFeedConfig,
  since: Date,
  titleLooksLikeRequest: (titleLower: string) => boolean,
): Promise<{ requests: RawRequest[]; listed: number }> {
  const base = feed.url.replace(/\/$/, '');
  const topics = new Map<number, { t: DiscourseTopic; category: string }>();
  let listed = 0;
  for (const cat of feed.categories) {
    for (let page = 0; page < feed.max_pages; page++) {
      const list = JSON.parse(await json(fetcher, `${base}/c/${cat.path}.json?page=${page}`)) as DiscourseList;
      const batch = list.topic_list.topics;
      for (const t of batch) {
        if (new Date(t.created_at) < since) continue;
        listed++;
        if (/^about the /i.test(t.title)) continue;
        if (cat.all || titleLooksLikeRequest(t.title.toLowerCase())) topics.set(t.id, { t, category: cat.path });
      }
      // Lists are ordered by last activity: once a whole page is older than the window, stop.
      if (!list.topic_list.more_topics_url || batch.every((t) => new Date(t.bumped_at) < since)) break;
    }
  }
  const requests: RawRequest[] = [];
  for (const { t, category } of topics.values()) {
    const topic = JSON.parse(await json(fetcher, `${base}/t/${t.id}.json`)) as DiscourseTopicJson;
    const first = topic.post_stream.posts[0];
    if (!first) continue;
    requests.push({
      source: feed.id,
      itemId: String(t.id),
      url: `${base}/t/${t.slug}/${t.id}`,
      publishedAt: new Date(topic.created_at).toISOString(),
      author: first.username,
      organisation: null,
      title: topic.title,
      text: forumHtmlToText(first.cooked).slice(0, TEXT_CHARS),
      header: topic.title,
      context: `${feed.label} · ${category.replace(/\/\d+$/, '')}`,
      replies: Math.max(0, t.posts_count - 1),
    });
  }
  return { requests, listed };
}
