/**
 * What a far machine's bytes may become in the page. A far machine is hostile input. A blob: URL inherits this page's origin, so
 * HTML or an SVG document in one is script with this page's keys, should anything navigate to it or frame it. So:
 *   image, media   this exact list, and the blob's type is this list's text, never the far side's. These never run as a document.
 *   svg            a data: URL, never a blob. Safe in an <img>, and a data: URL has no origin to inherit if it is ever opened.
 *   other          no URL at all. The person is offered a download, whose blob has a type no browser runs.
 */
const IMAGE = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"];
const MEDIA = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/flac", "audio/aac"];
const KINDS = new Map([...IMAGE.map((t) => [t, "image"]), ...MEDIA.map((t) => [t, "media"]), ["image/svg+xml", "svg"]]);

const MIB = 1024 * 1024;
/** Past this a file is offered as a download, not held in memory as a blob. */
export const BLOB_LIMIT = 200 * MIB;
/** Blob URLs held at once, older ones let go of first. */
export const HELD_LIMIT = 400 * MIB;
/** An SVG is text for an <img>, and a data: URL is held as a string. */
export const SVG_LIMIT = 16 * MIB;
/** A download with no file dialog is kept in pieces, which browsers may put on disk. Past this it is too much to ask of one. */
export const BATCHED_LIMIT = 2 * 1024 * MIB;
export const BATCH_BYTES = 16 * MIB;
/** A blob of this is saved, and shown by no browser as anything. */
export const DOWNLOAD_TYPE = "application/octet-stream";

/** `type` is the text to give a blob, from the list above. Only an exact match counts: anything odd is `other`. */
export function fileClass(contentType) {
  if (typeof contentType !== "string") return { kind: "other", type: null };
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  const kind = KINDS.get(type);
  return kind ? { kind, type } : { kind: "other", type: null };
}

/** A name for a saved file: the last part of the path, with nothing a file system would read as anything else. */
export function downloadName(name) {
  const last = String(name ?? "").split(/[\\/]/).pop();
  // eslint-disable-next-line no-control-regex
  return [...last.replace(/[\u0000-\u001f\u007f\p{Cf}\p{Zl}\p{Zp}]/gu, "")].slice(0, 200).join("").replace(/^\.+/, "") || "download";
}
