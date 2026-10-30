// Static assets can come back from the ASSETS binding as application/octet-stream
// (or with no type) when they were stored without one. Browsers refuse CSS/JS like
// that under nosniff, so set the type from the file extension in that case.

export const ASSET_TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
};

/** Content type for a path by extension, or null when unknown. */
export function typeForPath(path) {
  const m = /\.([a-z0-9]+)$/i.exec(String(path || ""));
  return m ? ASSET_TYPES[m[1].toLowerCase()] || null : null;
}

/** Return res unchanged unless its type is missing or octet-stream and the extension is known. */
export function withAssetType(res, path) {
  const current = (res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (current && current !== "application/octet-stream") return res;
  const type = typeForPath(path);
  if (!type) return res;
  const headers = new Headers(res.headers);
  headers.set("Content-Type", type);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
