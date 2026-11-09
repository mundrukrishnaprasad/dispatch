/**
 * Dispatch ingest.
 *
 * Pulls the current edition from public RSS/Atom feeds that publish full
 * article text, splits the reporting into passages, embeds them with Workers
 * AI and writes the text (D1) and vectors (Vectorize).
 */

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  ASSETS: Fetcher;
  INGEST_KEY?: string;
  SITE_URL?: string;
}

interface Feed {
  url: string;
  source: string;
  limit: number;
  format: "rss" | "atom";
}

interface FeedItem {
  title: string;
  url: string;
  source: string;
  published: string;
  summary: string;
  content: string;
}

interface EditionArticle extends FeedItem {
  id: string;
  body: string;
}

interface EditionChunk {
  id: string;
  articleId: string;
  ord: number;
  text: string;
}

const FEEDS: Feed[] = [
  {
    url: "https://theconversation.com/global/articles.atom",
    source: "The Conversation",
    limit: 8,
    format: "atom"
  },
  {
    url: "https://www.propublica.org/feeds/propublica/main",
    source: "ProPublica",
    limit: 5,
    format: "rss"
  },
  {
    url: "https://feeds.arstechnica.com/arstechnica/index",
    source: "Ars Technica",
    limit: 4,
    format: "rss"
  },
  {
    url: "https://www.theverge.com/rss/index.xml",
    source: "The Verge",
    limit: 4,
    format: "atom"
  }
];

const UA = "Dispatch/1.0 (+https://dispatch.kp489292.workers.dev; newsroom demo)";
const MAX_CHUNKS_PER_ARTICLE = 3;
const CHUNK_SIZE = 900;
const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";

export async function runIngest(env: Env): Promise<Record<string, unknown>> {
  const started = Date.now();
  const errors: string[] = [];

  const feedResults = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const items = await readFeed(feed);
        if (!items.length) errors.push(`${feed.source}: no readable entries`);
        return items;
      } catch (error) {
        errors.push(`${feed.source}: ${message(error)}`);
        return [] as FeedItem[];
      }
    })
  );

  const items = dedupe(feedResults.flat()).slice(0, 24);

  if (!items.length) {
    throw new Error("No stories could be read from any feed.");
  }

  const articles: EditionArticle[] = [];
  for (const item of items) {
    const id = await hash(item.url);
    const text = [item.title, item.content].filter(Boolean).join("\n\n").slice(0, 4200);
    articles.push({ ...item, id, body: text });
  }

  // Build passages.
  const chunks: EditionChunk[] = [];
  for (const article of articles) {
    const parts = chunkText(article.body);
    parts.forEach((text, ord) => {
      chunks.push({
        id: `${article.id}-${ord}`,
        articleId: article.id,
        ord,
        text
      });
    });
  }

  if (!chunks.length) {
    throw new Error("No readable passages were produced.");
  }

  // Embed the edition.
  const vectors: VectorizeVector[] = [];
  const articlesById = new Map(articles.map((article) => [article.id, article]));

  for (let i = 0; i < chunks.length; i += 16) {
    const batch = chunks.slice(i, i + 16);
    const embedded = (await env.AI.run(EMBED_MODEL, {
      text: batch.map((chunk) => chunk.text)
    })) as { data: number[][] };

    if (!embedded?.data?.length) {
      throw new Error("The embedding model returned no vectors.");
    }

    embedded.data.forEach((values, index) => {
      const chunk = batch[index];
      const article = articlesById.get(chunk.articleId);
      if (!article) return;

      vectors.push({
        id: chunk.id,
        values,
        metadata: {
          title: article.title.slice(0, 300),
          url: article.url,
          source: article.source,
          published: article.published,
          text: chunk.text,
          ord: chunk.ord
        }
      });
    });
  }

  // Remove last edition's passages before writing the new one.
  const previous = await env.DB.prepare("SELECT id FROM chunks").all<{ id: string }>();
  const previousIds = (previous.results ?? []).map((row) => row.id);
  if (previousIds.length) {
    for (let i = 0; i < previousIds.length; i += 500) {
      await env.VECTORIZE.deleteByIds(previousIds.slice(i, i + 500));
    }
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks"),
    env.DB.prepare("DELETE FROM articles"),
    env.DB.prepare("DELETE FROM meta")
  ]);

  const now = new Date().toISOString();

  // Insert articles.
  for (let i = 0; i < articles.length; i += 20) {
    await env.DB.batch(
      articles.slice(i, i + 20).map((article) =>
        env.DB.prepare(
          "INSERT INTO articles (id, title, url, source, published, summary, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          article.id,
          article.title,
          article.url,
          article.source,
          article.published,
          article.summary,
          now
        )
      )
    );
  }

  // Insert passages.
  for (let i = 0; i < chunks.length; i += 40) {
    await env.DB.batch(
      chunks.slice(i, i + 40).map((chunk) =>
        env.DB.prepare("INSERT INTO chunks (id, article_id, ord, text) VALUES (?, ?, ?, ?)").bind(
          chunk.id,
          chunk.articleId,
          chunk.ord,
          chunk.text
        )
      )
    );
  }

  await env.DB.batch([
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('last_ingest', ?)").bind(now),
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('article_count', ?)").bind(String(articles.length)),
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('chunk_count', ?)").bind(String(chunks.length))
  ]);

  // Publish vectors in one pass; Vectorize accepts up to 1,000 per call.
  for (let i = 0; i < vectors.length; i += 500) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 500));
  }

  return {
    ok: true,
    articles: articles.length,
    passages: chunks.length,
    feeds: FEEDS.length,
    errors,
    ms: Date.now() - started
  };
}

async function readFeed(feed: Feed): Promise<FeedItem[]> {
  const response = await fetch(feed.url, {
    headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`feed responded ${response.status}`);
  }

  const xml = await response.text();
  const items: FeedItem[] = [];
  const pattern = feed.format === "atom" ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

  for (const match of xml.matchAll(pattern)) {
    if (items.length >= feed.limit) break;
    const entry = match[1];

    const title = clean(extractTag(entry, "title"));
    const link =
      feed.format === "atom"
        ? clean(extractAtomLink(entry))
        : clean(extractTag(entry, "link"));
    if (!title || !link) continue;

    const rawContent =
      extractTag(entry, "content:encoded") ||
      extractTag(entry, "content") ||
      extractTag(entry, "description") ||
      extractTag(entry, "summary");
    const content = htmlToText(rawContent).slice(0, 4200);

    if (content.length < 120) continue;

    const published = toIso(
      extractTag(entry, "published") || extractTag(entry, "pubDate") || extractTag(entry, "updated")
    );

    items.push({
      title,
      url: link,
      source: feed.source,
      published,
      summary: content.slice(0, 400),
      content
    });
  }

  return items;
}

function htmlToText(html: string): string {
  const decoded = decodeEntities(html);
  const paragraphs = Array.from(decoded.matchAll(/<(p|h2|h3|li)\b[^>]*>([\s\S]*?)<\/\1>/gi))
    .map((match) => stripTags(match[2]).replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 40);

  if (paragraphs.length) return paragraphs.join("\n\n");
  return stripTags(decoded).replace(/\s+/g, " ").trim();
}

function chunkText(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= CHUNK_SIZE) return normalized.length >= 60 ? [normalized] : [];

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current + " " + sentence).length > CHUNK_SIZE && current.length > 150) {
      chunks.push(current.trim());
      current = sentence;
      if (chunks.length >= MAX_CHUNKS_PER_ARTICLE) break;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }

  if (current && chunks.length < MAX_CHUNKS_PER_ARTICLE) {
    chunks.push(current.trim());
  }

  return chunks.filter((chunk) => chunk.length >= 60).slice(0, MAX_CHUNKS_PER_ARTICLE);
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  let value = match[1].trim();
  if (value.startsWith("<![CDATA[")) {
    value = value.slice(9, value.endsWith("]]>") ? -3 : undefined);
  }
  return value;
}

function extractAtomLink(entry: string): string {
  const links = Array.from(entry.matchAll(/<link\b[^>]*>/gi)).map((match) => match[0]);
  const alternate = links.find((link) => !/rel=["']self["']/i.test(link)) ?? links[0] ?? "";
  return alternate.match(/href=["']([^"']+)["']/i)?.[1] ?? "";
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function clean(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ldquo: "\u201C",
    rdquo: "\u201D",
    lsquo: "\u2018",
    rsquo: "\u2019",
    mdash: "\u2014",
    ndash: "\u2013",
    hellip: "\u2026"
  };

  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function toIso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function dedupe(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const url = item.url.split("?")[0];
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
