import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/worker.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const policyPath = path.join(root, "public/one-click-pdf/privacy.html");
const sourcePath = "/workspace/save-pdf-ext/store/privacy-policy.html";
const policyHtml = fs.readFileSync(policyPath, "utf8");

const KEY_SENTENCES = [
  "One-Click PDF: Privacy Policy",
  "One-Click PDF does not collect, store, or transmit your browsing data or the pages you save.",
  "We do <b>not</b> collect, record, or transmit the web pages you visit or save",
  "We do <b>not</b> use analytics, tracking pixels, advertising identifiers, or cookies in the extension.",
  "We do <b>not</b> sell, rent, or share any personal data.",
  "The extension is not directed to children under 13 and does not knowingly collect information from them.",
  "Effective November 11, 2026",
];

/** Assets binding that reads from public/, with html_handling: none. */
const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!rel || rel.endsWith("/")) {
      return new Response("Not found", { status: 404 });
    }
    const file = path.join(root, "public", rel);
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.join(root, "public") + path.sep)) {
      return new Response("Not found", { status: 404 });
    }
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      return new Response("Not found", { status: 404 });
    }
    const body = fs.readFileSync(resolved);
    const type = resolved.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
    return new Response(body, { status: 200, headers: { "Content-Type": type } });
  },
};

const env = {
  ASSETS,
  CHECKOUT_ENABLED: "true",
  SQUARE_ENVIRONMENT: "production",
  SITE_ORIGIN: "https://packmulehouse.com",
  SHIPPING_CENTS: "1000",
};

async function get(pathname) {
  return worker.fetch(new Request(`https://packmulehouse.com${pathname}`), env, {});
}

test("one-click-pdf privacy page is a word-for-word copy of the source policy", () => {
  assert.equal(fs.existsSync(policyPath), true);
  if (fs.existsSync(sourcePath)) {
    assert.equal(
      fs.readFileSync(policyPath, "utf8"),
      fs.readFileSync(sourcePath, "utf8"),
      "public/one-click-pdf/privacy.html must match the source policy file"
    );
  }
  for (const sentence of KEY_SENTENCES) {
    assert.match(policyHtml, new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("GET /one-click-pdf/privacy returns 200 HTML containing the policy text", async () => {
  const res = await get("/one-click-pdf/privacy");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /^text\/html\b/i);
  const body = await res.text();
  for (const sentence of KEY_SENTENCES) {
    assert.match(body, new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(body, /<form\b/i);
  assert.doesNotMatch(body, /type=["']password["']/i);
});

test("GET /one-click-pdf/privacy/ also returns 200 with the same policy text", async () => {
  const res = await get("/one-click-pdf/privacy/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /^text\/html\b/i);
  const body = await res.text();
  assert.match(body, /One-Click PDF does not collect, store, or transmit your browsing data or the pages you save\./);
});

test("one-click-pdf privacy is not in the sitemap, nav, or footer", () => {
  const workerSrc = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  const sitemap = workerSrc.match(/const SITEMAP_PATHS = (\[[^\]]+\])/);
  assert.ok(sitemap);
  assert.doesNotMatch(sitemap[1], /one-click-pdf/);
  const pages = ["index", "quote", "contact", "shipping", "returns", "privacy", "terms", "how-it-works"];
  for (const name of pages) {
    const html = fs.readFileSync(path.join(root, "public", `${name}.html`), "utf8");
    assert.equal(html.includes("/one-click-pdf/privacy"), false, `${name}.html should not link the extension policy`);
  }
});
