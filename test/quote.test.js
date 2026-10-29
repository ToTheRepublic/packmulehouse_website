import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CONTENT_SECURITY_POLICY, contentSecurityPolicy } from "../src/headers.js";

const dir = (n) => (csp) => csp.split("; ").find((d) => d.startsWith(n + " "));

test("CSP allows Sliceworth in script-src and frame-src only", () => {
  for (const csp of [CONTENT_SECURITY_POLICY, contentSecurityPolicy({ SQUARE_ENVIRONMENT: "production" })]) {
    assert.match(dir("script-src")(csp), /https:\/\/sliceworth\.com/);
    assert.match(dir("frame-src")(csp), /https:\/\/sliceworth\.com/);
    const others = csp.split("; ").filter((d) => !/^(script|frame)-src /.test(d));
    for (const d of others) assert.doesNotMatch(d, /sliceworth/);
  }
});

test("quote page embeds the Sliceworth widget with a noscript fallback", () => {
  const html = fs.readFileSync(new URL("../public/quote.html", import.meta.url), "utf8");
  assert.match(html, /<h1>Get an instant quote<\/h1>/);
  assert.ok(html.includes('<script src="https://sliceworth.com/embed.js" data-shop="packmule" data-theme="dark" async></script>'));
  assert.match(html, /<noscript><iframe src="https:\/\/sliceworth\.com\/s\/packmule\/embed\?theme=dark"/);
});

test("every page links to /quote and carries the footer note", () => {
  for (const f of ["index", "contact", "privacy", "returns", "shipping", "terms", "quote"]) {
    const html = fs.readFileSync(new URL(`../public/${f}.html`, import.meta.url), "utf8");
    assert.match(html, /href="\/quote"/, f);
    assert.match(html, /Run a print shop\? Get instant quotes on your site/, f);
  }
});

test("quote page has the site header nav and mobile menu", () => {
  const html = fs.readFileSync(new URL("../public/quote.html", import.meta.url), "utf8");
  assert.match(html, /id="nav-toggle"/);
  assert.match(html, /<nav class="nav" id="site-nav"/);
  assert.match(html, /href="\/#products"/);
  assert.match(html, /<script src="\/nav\.js" defer><\/script>/);
  assert.match(html, /href="\/site-header\.css"/);
});
