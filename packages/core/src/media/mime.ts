/**
 * Image extension ↔ MIME type — the one table behind every place halo decides
 * "is this file a picture?" and "what Content-Type does it get?".
 *
 * This lived in six copies (cli resolve-refs + TUI path suggest, server
 * channels/shared/media + media-store, routes/web, routes/files): adding a
 * format meant six edits, and a miss showed up as one surface treating a file
 * differently from the rest. Callers keep their own non-image entries and
 * their own filters — only the image lookup is shared.
 */

/** Raster photo formats: what "this file is a picture" means on the paths that
 *  hand bytes to a vision model or to a channel's sendPhoto. */
const PHOTO_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** Image formats that get a real Content-Type when served over HTTP but are
 *  NOT photos: svg is markup (no vision API accepts it), ico/avif have no
 *  channel photo support. Deliberately outside `IMAGE_EXTS` — `@file logo.svg`
 *  must inline the markup as text, and a channel must send an .svg as a
 *  document rather than a photo. */
const SERVE_ONLY_MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

const IMAGE_MIME_BY_EXT: Record<string, string> = { ...PHOTO_MIME_BY_EXT, ...SERVE_ONLY_MIME_BY_EXT };

/** Reverse direction is photo-only on purpose: its one caller names *inbound
 *  media files* from a wire MIME type, and there is no such thing as an
 *  inbound svg/ico/avif "photo". Keeping them out means an uploaded
 *  `image/svg+xml` keeps landing as a sniffed `.bin` rather than becoming a
 *  `.svg` that the file routes then serve inline.
 *  First ext wins, so `image/jpeg` maps back to `.jpg` (not `.jpeg`). */
const EXT_BY_PHOTO_MIME: Record<string, string> = {};
for (const [ext, mime] of Object.entries(PHOTO_MIME_BY_EXT)) {
  EXT_BY_PHOTO_MIME[mime] ??= ext;
}

/** Photo extensions, dotted and lowercase (`.png`). Derived from the table, so
 *  the membership test and the MIME lookup can never disagree. */
export const IMAGE_EXTS: ReadonlySet<string> = new Set(Object.keys(PHOTO_MIME_BY_EXT));

/** `png` / `.PNG` / `.png` → `.png`. Callers pass either `path.extname()`
 *  output (dotted) or a bare `split('.').pop()`. */
function normalizeExt(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

/** MIME type for an image extension, `undefined` when the extension isn't a
 *  known image — the fallback belongs to the caller (octet-stream when
 *  serving, a plain text read when inlining). */
export function imageMimeFromExt(ext: string): string | undefined {
  return IMAGE_MIME_BY_EXT[normalizeExt(ext)];
}

/** Canonical dotted extension for a photo MIME type, `undefined` when the type
 *  isn't a photo (see `EXT_BY_PHOTO_MIME`). Used when naming a file whose type
 *  came off the wire. */
export function extFromImageMime(mime: string): string | undefined {
  return EXT_BY_PHOTO_MIME[mime.toLowerCase()];
}
