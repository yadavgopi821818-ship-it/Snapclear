import { SNAP_PAGE_HOSTS } from "./hosts";
import { preferCleanMediaUrl, watermarkedMediaUrl } from "./clean-url";
import type {
  SnapItem,
  SnapKind,
  SnapProfile,
  SnapResolveResult,
  SnapSource,
} from "./types";

const PAGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const USERNAME_RE = /^@?([a-zA-Z][a-zA-Z0-9._-]{1,31})$/;
const SPOTLIGHT_ID_RE = /\/spotlight\/([A-Za-z0-9_-]+)/;
const HIGHLIGHT_ID_RE = /\/highlight\/([A-Za-z0-9_-]+)/;

export class SnapResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapResolveError";
  }
}

export async function resolveSnapUrl(rawInput: string): Promise<SnapResolveResult> {
  const result = await resolvePublicSnap(rawInput);
  return { ...result, items: await confirmCleanItems(result.items) };
}

async function resolvePublicSnap(rawInput: string): Promise<SnapResolveResult> {
  const target = normalizeSnapInput(rawInput);
  const { html, finalUrl } = await fetchSnapPage(target);
  const page = parseNextData(html);
  const ldItems = parseJsonLdVideos(html);
  const ogVideo = parseOgVideo(html);

  const spotlightId = firstMatch(finalUrl, SPOTLIGHT_ID_RE);
  const highlightId = firstMatch(finalUrl, HIGHLIGHT_ID_RE);

  if (page) {
    if (spotlightId) {
      const item =
        itemFromVideoMetadata(asRecord(page.videoMetadata), "spotlight") ??
        findSpotlightInFeed(page, spotlightId) ??
        ldItems[0] ??
        itemFromOg(ogVideo, spotlightId);
      if (!item) {
        throw new SnapResolveError(
          "This Spotlight could not be found. It may have expired or been removed.",
        );
      }
      return {
        mode: "single",
        canonicalUrl: finalUrl,
        profile: profileFromPage(page),
        items: [item],
      };
    }

    if (highlightId) {
      const items = itemsFromHighlightId(page, highlightId);
      if (items.length === 0) {
        throw new SnapResolveError("This highlight could not be found or is no longer public.");
      }
      return {
        mode: items.length > 1 ? "collection" : "single",
        canonicalUrl: finalUrl,
        profile: profileFromPage(page),
        items,
      };
    }

    const collection = collectProfileMedia(page);
    if (collection.items.length > 0) {
      return {
        mode: "collection",
        canonicalUrl: finalUrl,
        profile: collection.profile,
        items: collection.items,
      };
    }
  }

  if (ldItems.length > 0) {
    return {
      mode: ldItems.length > 1 ? "collection" : "single",
      canonicalUrl: finalUrl,
      profile: null,
      items: ldItems,
    };
  }

  const ogItem = itemFromOg(ogVideo, spotlightId ?? "snap");
  if (ogItem) {
    return {
      mode: "single",
      canonicalUrl: finalUrl,
      profile: null,
      items: [ogItem],
    };
  }

  throw new SnapResolveError(
    "No public video found. Private Snaps and friends-only Stories cannot be downloaded.",
  );
}

export function normalizeSnapInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new SnapResolveError("Paste a Snapchat Spotlight, Story, or public profile link.");
  }
  if (trimmed.length > 2048) {
    throw new SnapResolveError("That link is too long.");
  }

  const asUser = USERNAME_RE.exec(trimmed);
  if (asUser) {
    return `https://www.snapchat.com/@${asUser[1]}`;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new SnapResolveError("That does not look like a Snapchat link.");
  }

  if (!SNAP_PAGE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new SnapResolveError(
      "Only snapchat.com, story.snapchat.com, and t.snapchat.com links are supported.",
    );
  }

  url.protocol = "https:";
  return url.toString();
}

async function fetchSnapPage(url: string): Promise<{ html: string; finalUrl: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(18000),
      headers: {
        "User-Agent": PAGE_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch {
    throw new SnapResolveError("Could not reach Snapchat. Check the link and try again.");
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new SnapResolveError("Snapchat returned 404. This link may have expired.");
    }
    throw new SnapResolveError("Snapchat did not return this page. Try again in a moment.");
  }

  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > 8_000_000) {
    throw new SnapResolveError("The Snapchat page was too large to process.");
  }

  const html = await response.text();
  if (html.length > 8_000_000) {
    throw new SnapResolveError("The Snapchat page was too large to process.");
  }

  const finalUrl = response.url || url;
  try {
    const host = new URL(finalUrl).hostname.toLowerCase();
    if (!SNAP_PAGE_HOSTS.has(host)) {
      throw new SnapResolveError("That link did not resolve to a public Snapchat page.");
    }
  } catch (err) {
    if (err instanceof SnapResolveError) throw err;
    throw new SnapResolveError("That link did not resolve to a public Snapchat page.");
  }

  return { html, finalUrl };
}

function parseNextData(html: string): Record<string, unknown> | null {
  const match = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    const pageProps = get(parsed, ["props", "pageProps"]);
    return asRecord(pageProps);
  } catch {
    return null;
  }
}

function parseJsonLdVideos(html: string): SnapItem[] {
  const items: SnapItem[] = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1]!) as unknown;
      collectLd(parsed, items);
    } catch {
      // ignore malformed blocks
    }
  }
  return dedupeItems(items);
}

function collectLd(node: unknown, out: SnapItem[]) {
  if (Array.isArray(node)) {
    for (const child of node) collectLd(child, out);
    return;
  }
  const rec = asRecord(node);
  if (!rec) return;
  if (Array.isArray(rec["@graph"])) collectLd(rec["@graph"], out);
  const types = Array.isArray(rec["@type"]) ? rec["@type"] : [rec["@type"]];
  if (types.includes("VideoObject")) {
    const item = itemFromLd(rec);
    if (item) out.push(item);
  }
}

function parseOgVideo(html: string): { video: string | null; image: string | null; title: string | null } {
  return {
    video: metaContent(html, "og:video") ?? metaContent(html, "og:video:secure_url"),
    image: metaContent(html, "og:image"),
    title: metaContent(html, "og:title"),
  };
}

function metaContent(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const m = html.match(re);
  return m?.[1] ? decodeHtml(m[1]) : null;
}

function findSpotlightInFeed(page: Record<string, unknown>, id: string): SnapItem | null {
  const stories = asArray(get(page, ["spotlightFeed", "spotlightStories"]));
  for (const story of stories) {
    const rec = asRecord(story);
    if (!rec) continue;
    const storyId = str(get(rec, ["story", "storyId", "value"])) ?? str(get(rec, ["story", "storyId"]));
    if (storyId !== id) continue;
    const meta = asRecord(rec.metadata);
    const fromMeta = itemFromVideoMetadata(asRecord(meta?.videoMetadata), "spotlight");
    if (fromMeta) return fromMeta;
    const snaps = itemsFromStory(asRecord(rec.story), "spotlight", meta);
    if (snaps[0]) return snaps[0];
  }
  return null;
}

function itemsFromHighlightId(page: Record<string, unknown>, id: string): SnapItem[] {
  const buckets = [
    asArray(page.curatedHighlights),
    asArray(page.spotlightHighlights),
  ];
  for (const bucket of buckets) {
    for (const story of bucket) {
      const rec = asRecord(story);
      if (!rec) continue;
      const storyId = str(get(rec, ["storyId", "value"])) ?? str(rec.storyId);
      const highlightId = str(get(rec, ["highlightId", "value"])) ?? str(rec.highlightId);
      if (storyId !== id && highlightId !== id) continue;
      return itemsFromStory(rec, "highlight");
    }
  }
  return [];
}

function collectProfileMedia(page: Record<string, unknown>): {
  profile: SnapProfile | null;
  items: SnapItem[];
} {
  const profile = profileFromPage(page);
  const items: SnapItem[] = [];

  const liveStory = asRecord(page.story);
  if (liveStory) items.push(...itemsFromStory(liveStory, "story"));

  const spotlightMeta = asArray(page.spotlightStoryMetadata);
  const spotlightStories = asArray(page.spotlightHighlights);
  for (let i = 0; i < spotlightStories.length && items.length < 48; i++) {
    const meta = asRecord(spotlightMeta[i]);
    const fromMeta = itemFromVideoMetadata(asRecord(meta?.videoMetadata), "spotlight");
    if (fromMeta) {
      items.push(fromMeta);
      continue;
    }
    items.push(...itemsFromStory(asRecord(spotlightStories[i]), "spotlight", meta).slice(0, 1));
  }

  const highlights = asArray(page.curatedHighlights);
  for (const story of highlights) {
    if (items.length >= 48) break;
    items.push(...itemsFromStory(asRecord(story), "highlight").slice(0, 1));
  }

  return { profile, items: dedupeItems(items).slice(0, 40) };
}

function itemsFromStory(
  story: Record<string, unknown> | null,
  source: SnapSource,
  metadata?: Record<string, unknown> | null,
): SnapItem[] {
  if (!story) return [];
  const snaps = asArray(story.snapList);
  const storyTitle =
    str(story.storyTitle) ??
    str(get(metadata, ["videoMetadata", "name"])) ??
    (source === "story" ? "Story snap" : source === "highlight" ? "Highlight" : "Spotlight Snap");
  const out: SnapItem[] = [];
  snaps.forEach((snap, index) => {
    const rec = asRecord(snap);
    if (!rec) return;
    const mediaUrl = str(get(rec, ["snapUrls", "mediaUrl"]));
    if (!mediaUrl || !mediaUrl.startsWith("https://")) return;
    const id =
      str(get(rec, ["snapId", "value"])) ??
      str(get(story, ["storyId", "value"])) ??
      `${source}-${index}`;
    const kind = inferKind(rec.snapMediaType, mediaUrl);
    const title =
      str(rec.snapTitle) ??
      (snaps.length > 1 ? `${storyTitle} ${index + 1}` : storyTitle);
    const uploadedAt = unixToIso(str(get(rec, ["timestampInSec", "value"])) ?? rec.timestampInSec);
    out.push(
      finalizeItem({
        id,
        kind,
        source,
        title: title || storyTitle,
        description: str(get(metadata, ["description"])) ?? "",
        thumbnailUrl:
          str(get(rec, ["snapUrls", "mediaPreviewUrl", "value"])) ??
          str(get(story, ["thumbnailUrl", "value"])) ??
          null,
        mediaUrl,
        durationMs: null,
        width: null,
        height: null,
        uploadedAt,
        viewCount: null,
        hashtags: stringList(get(metadata, ["hashtags"])),
      }),
    );
  });
  return out;
}

function itemFromVideoMetadata(
  meta: Record<string, unknown> | null,
  source: SnapSource,
): SnapItem | null {
  if (!meta) return null;
  const mediaUrl = str(meta.contentUrl);
  if (!mediaUrl || !mediaUrl.startsWith("https://")) return null;
  const creator = asRecord(get(meta, ["creator", "personCreator"])) ?? asRecord(meta.creator);
  const title = str(meta.name) || str(meta.embeddedTextCaption) || "Spotlight Snap";
  const id =
    lastPathSegment(mediaUrl) ||
    `${source}-${str(meta.uploadDateMs) ?? Math.random().toString(36).slice(2)}`;
  return finalizeItem({
    id,
    kind: "video",
    source,
    title,
    description: str(meta.description) ?? "",
    thumbnailUrl: str(meta.thumbnailUrl),
    mediaUrl,
    durationMs: num(meta.durationMs),
    width: num(meta.width),
    height: num(meta.height),
    uploadedAt: msToIso(meta.uploadDateMs),
    viewCount: num(meta.viewCount),
    hashtags: stringList(meta.keywords),
    uploader: str(creator?.username),
  });
}

function itemFromLd(rec: Record<string, unknown>): SnapItem | null {
  const mediaUrl = str(rec.contentUrl);
  if (!mediaUrl || !mediaUrl.startsWith("https://")) return null;
  const creator = asRecord(rec.creator);
  return finalizeItem({
    id: lastPathSegment(str(rec.url) ?? mediaUrl) || "snap",
    kind: "video",
    source: "spotlight",
    title: str(rec.name) || "Spotlight Snap",
    description: str(rec.description) ?? "",
    thumbnailUrl: firstString(rec.thumbnailUrl),
    mediaUrl,
    durationMs: isoDurationToMs(str(rec.duration)),
    width: null,
    height: null,
    uploadedAt: str(rec.uploadDate),
    viewCount: null,
    hashtags: stringList(rec.keywords),
    uploader: str(creator?.alternateName) ?? str(creator?.name),
  });
}

function itemFromOg(
  og: { video: string | null; image: string | null; title: string | null },
  id: string,
): SnapItem | null {
  if (!og.video || !og.video.startsWith("https://")) return null;
  return finalizeItem({
    id,
    kind: "video",
    source: "spotlight",
    title: og.title || "Spotlight Snap",
    description: "",
    thumbnailUrl: og.image,
    mediaUrl: og.video,
    durationMs: null,
    width: null,
    height: null,
    uploadedAt: null,
    viewCount: null,
    hashtags: [],
  });
}

function profileFromPage(page: Record<string, unknown>): SnapProfile | null {
  const info =
    asRecord(get(page, ["userProfile", "publicProfileInfo"])) ??
    asRecord(get(page, ["userProfile"]));
  if (!info) return null;
  const username = str(info.username);
  if (!username) return null;
  return {
    username,
    displayName: str(info.title) || str(info.name) || username,
    bio: str(info.bio) ?? "",
    avatarUrl: str(info.profilePictureUrl),
    subscriberCount: num(info.subscriberCount),
  };
}

function finalizeItem(
  item: Omit<SnapItem, "downloadName"> & { uploader?: string | null },
): SnapItem {
  const { uploader: _uploader, ...rest } = item;
  const ext = rest.kind === "photo" ? "jpg" : "mp4";
  const mediaUrl =
    rest.kind === "video" ? preferCleanMediaUrl(rest.mediaUrl) : rest.mediaUrl;
  return {
    ...rest,
    mediaUrl,
    viewCount: rest.viewCount != null && rest.viewCount < 0 ? null : rest.viewCount,
    width: rest.width === 0 ? null : rest.width,
    height: rest.height === 0 ? null : rest.height,
    downloadName: slugFilename(rest.title, ext),
  };
}

async function confirmCleanItems(items: SnapItem[]): Promise<SnapItem[]> {
  return Promise.all(
    items.map(async (item) => {
      if (item.kind !== "video") return item;
      const clean = preferCleanMediaUrl(item.mediaUrl);
      if (clean === item.mediaUrl) {
        if (await mediaExists(item.mediaUrl)) return item;
        const stamped = watermarkedMediaUrl(item.mediaUrl);
        if (stamped !== item.mediaUrl && (await mediaExists(stamped))) {
          return { ...item, mediaUrl: stamped };
        }
        return item;
      }
      if (await mediaExists(clean)) return { ...item, mediaUrl: clean };
      return item;
    }),
  );
}

async function mediaExists(url: string): Promise<boolean> {
  const headers = {
    "User-Agent": PAGE_UA,
    Referer: "https://www.snapchat.com/",
    Accept: "*/*",
  };
  try {
    const head = await fetch(url, {
      method: "HEAD",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    if (head.ok) return true;
  } catch {
    // Some CDNs reject HEAD; try a 1-byte GET.
  }
  try {
    const get = await fetch(url, {
      method: "GET",
      headers: { ...headers, Range: "bytes=0-1" },
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    return get.ok || get.status === 206;
  } catch {
    return false;
  }
}

function inferKind(mediaType: unknown, url: string): SnapKind {
  const n = num(mediaType);
  if (n === 0) return "photo";
  if (n === 1) return "video";
  if (/\.(jpe?g|png|webp)(\?|$)/i.test(url)) return "photo";
  return "video";
}

function slugFilename(title: string, ext: string): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[^\w\s.-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 72) || "snapchat";
  return `${base}.${ext}`;
}

function dedupeItems(items: SnapItem[]): SnapItem[] {
  const seen = new Set<string>();
  const out: SnapItem[] = [];
  for (const item of items) {
    const key = item.mediaUrl.split("?")[0] ?? item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function firstMatch(url: string, re: RegExp): string | null {
  return re.exec(url)?.[1] ?? null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function get(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[key];
  }
  return cur;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x)).filter((x): x is string => Boolean(x));
}

function firstString(v: unknown): string | null {
  if (typeof v === "string") return str(v);
  if (Array.isArray(v)) return str(v[0]);
  return null;
}

function msToIso(v: unknown): string | null {
  const n = num(v);
  if (n == null || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function unixToIso(v: unknown): string | null {
  const n = num(v);
  if (n == null || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isoDurationToMs(iso: string | null): number | null {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(iso);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return ((h * 60 + min) * 60 + s) * 1000;
}

function lastPathSegment(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.at(-1) ?? null;
  } catch {
    return null;
  }
}

function decodeHtml(value: string): string {
  return value.replace(/&(amp|quot|#39|lt|gt);/g, (_full, ent: string) => {
    if (ent === "amp") return "&";
    if (ent === "quot") return '"';
    if (ent === "#39") return "'";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    return _full;
  });
}
