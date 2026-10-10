/**
 * Response headers. CSP allows the Square Web Payments SDK (sandbox and
 * production), Google Fonts, and the YouTube IFrame embed.
 * style-src 'unsafe-inline' is required by Square's card iframe and by the
 * page's own <style> blocks. Scripts are external files, so script-src
 * does not allow unsafe-inline.
 * img-src https: covers Square catalog photos, which are served from
 * changing image hosts.
 * This header is the only CSP. The HTML has no meta policy, so the two
 * cannot disagree. HTML responses are no-store and are not 304s, so a
 * previous deploy's policy cannot stay attached to a cached document.
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
  // Cash App Pay Kit is loaded by the Square SDK into this page:
  // sandbox.kit.cash.app/v1/pay.js and kit.cash.app/v1/pay.js (production).
  // Google Pay loads pay.google.com/gp/p/js/pay.js and www.gstatic.com.
  "script-src 'self' https://sandbox.web.squarecdn.com https://web.squarecdn.com https://sandbox.kit.cash.app https://kit.cash.app https://pay.google.com https://payments.google.com https://www.gstatic.com https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://sandbox.web.squarecdn.com https://web.squarecdn.com https://sandbox.kit.cash.app https://kit.cash.app https://pay.google.com https://www.gstatic.com",
  // cash-f.squarecdn.com serves CashSans / Cash Market (Square card iframe and Cash App Pay).
  "font-src 'self' https://fonts.gstatic.com https://square-fonts-production-f.squarecdn.com https://cash-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net data:",
  // https: covers Square catalog photos and Cash App / Google Pay images.
  "img-src 'self' data: blob: https:",
  // Cash App Pay Kit (sandbox and production) posts experiment data to
  // api.lab.amplitude.com and can also use Amplitude's api / api2 hosts.
  "connect-src 'self' https://sandbox.web.squarecdn.com https://web.squarecdn.com https://pci-connect.squareupsandbox.com https://pci-connect.squareup.com https://o160250.ingest.sentry.io https://www.youtube.com https://geoissuer.cardinalcommerce.com https://centinelapi.cardinalcommerce.com https://songbird.cardinalcommerce.com https://songbirdstag.cardinalcommerce.com https://pay.google.com https://payments.google.com https://google.com https://www.google.com https://www.googleapis.com https://api.cash.app https://sandbox.api.cash.app https://pay.cash.app https://sandbox.pay.cash.app https://api.lab.amplitude.com https://api.amplitude.com https://api2.amplitude.com https://apple-pay-gateway.apple.com https://apple-pay-gateway-cert.apple.com",
  // Cash App checkout and enclave iframes are served from the kit host.
  "frame-src 'self' https://sandbox.web.squarecdn.com https://web.squarecdn.com https://pci-connect.squareupsandbox.com https://pci-connect.squareup.com https://www.youtube.com https://www.youtube-nocookie.com https://geoissuer.cardinalcommerce.com https://centinelapi.cardinalcommerce.com https://songbird.cardinalcommerce.com https://songbirdstag.cardinalcommerce.com https://pay.google.com https://payments.google.com https://accounts.google.com https://www.google.com https://sandbox.kit.cash.app https://kit.cash.app https://pay.cash.app https://sandbox.pay.cash.app",
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
