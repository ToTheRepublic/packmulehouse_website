/**
 * Response headers. CSP allows the Square Web Payments SDK (sandbox and
 * production), Google Fonts, and the YouTube IFrame embed.
 * style-src 'unsafe-inline' is required by Square's card iframe and by the
 * page's own <style> blocks. Scripts are external files, so script-src
 * does not allow unsafe-inline.
 * img-src https: covers Square catalog photos, which are served from
 * changing image hosts.
 */

export function shouldNoindex(env, hostname) {
  if ((env?.SQUARE_ENVIRONMENT || "sandbox") !== "production") return true;
  const host = hostname || "";
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".workers.dev");
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://sandbox.web.squarecdn.com https://web.squarecdn.com https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://sandbox.web.squarecdn.com https://web.squarecdn.com",
  "font-src 'self' https://fonts.gstatic.com https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://sandbox.web.squarecdn.com https://web.squarecdn.com https://pci-connect.squareupsandbox.com https://pci-connect.squareup.com https://o160250.ingest.sentry.io https://www.youtube.com https://geoissuer.cardinalcommerce.com https://centinelapi.cardinalcommerce.com https://songbird.cardinalcommerce.com https://songbirdstag.cardinalcommerce.com",
  "frame-src 'self' https://sandbox.web.squarecdn.com https://web.squarecdn.com https://pci-connect.squareupsandbox.com https://pci-connect.squareup.com https://www.youtube.com https://www.youtube-nocookie.com https://geoissuer.cardinalcommerce.com https://centinelapi.cardinalcommerce.com https://songbird.cardinalcommerce.com https://songbirdstag.cardinalcommerce.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

export function securityHeaders(env, url, { html = false } = {}) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
  const host = url?.hostname || "";
  const https = url?.protocol === "https:" && host !== "localhost" && host !== "127.0.0.1";
  if (https) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  if (shouldNoindex(env, host)) {
    headers["X-Robots-Tag"] = "noindex, nofollow";
  }
  if (html) headers["Content-Type"] = "text/html; charset=utf-8";
  return headers;
}

export function applySecurityHeaders(target, env, url, opts) {
  const extra = securityHeaders(env, url, opts);
  for (const [k, v] of Object.entries(extra)) target.set(k, v);
  return target;
}
