import { createFileRoute } from "@tanstack/react-router";
import { mediaUrlCandidates } from "@/lib/snap/clean-url";
import { isAllowedMediaUrl } from "@/lib/snap/hosts";

const DOWNLOAD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MAX_BYTES = 200 * 1024 * 1024;

export const Route = createFileRoute("/api/download")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const src = url.searchParams.get("u");
        const nameRaw = url.searchParams.get("name") ?? "snapchat-video";

        if (!src || !isAllowedMediaUrl(src)) {
          return Response.json({ error: "Invalid media URL." }, { status: 400 });
        }

        const filename = sanitizeFilename(nameRaw);
        const candidates = mediaUrlCandidates(src).filter(isAllowedMediaUrl);

        let upstream: Response | null = null;
        for (const candidate of candidates) {
          try {
            const res = await fetch(candidate, {
              headers: {
                "User-Agent": DOWNLOAD_UA,
                Referer: "https://www.snapchat.com/",
                Accept: "*/*",
              },
              signal: AbortSignal.timeout(60000),
              redirect: "follow",
            });
            if (res.ok && res.body) {
              upstream = res;
              break;
            }
          } catch {
            // try the next rendition
          }
        }

        if (!upstream?.body) {
          return Response.json({ error: "Could not fetch the original file." }, { status: 502 });
        }

        const length = Number(upstream.headers.get("content-length") ?? "0");
        if (length > MAX_BYTES) {
          return Response.json({ error: "File is too large to download." }, { status: 413 });
        }

        const contentType = upstream.headers.get("content-type") || guessType(filename);
        const headers = new Headers();
        headers.set("Content-Type", contentType);
        headers.set("Content-Disposition", `attachment; filename="${filename}"`);
        headers.set("Cache-Control", "private, max-age=120");
        if (length > 0) headers.set("Content-Length", String(length));

        return new Response(upstream.body, { status: 200, headers });
      },
    },
  },
});

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
  if (!cleaned) return "snapchat-video.mp4";
  if (!/\.[a-z0-9]{2,4}$/i.test(cleaned)) return `${cleaned}.mp4`;
  return cleaned;
}

function guessType(name: string): string {
  if (/\.(jpe?g)$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "video/mp4";
}