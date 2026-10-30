import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PAGES = ["index", "quote", "contact", "shipping", "returns", "privacy", "terms"];
const read = (f) => fs.readFileSync(new URL(`../public/${f}.html`, import.meta.url), "utf8");
const header = (html) => html.match(/<header class="header">[\s\S]*?<\/header>/)?.[0];
const footer = (html) => html.match(/<footer class="footer">[\s\S]*?<\/footer>/)?.[0];
// The homepage marks nothing current; /quote marks its own nav link.
const plainHeader = (h) => h.replace(/ aria-current="page"/g, "");

test("every page has the full site header (logo + nav + mobile menu)", () => {
  const ref = plainHeader(header(read("quote")));
  for (const f of PAGES) {
    const html = read(f);
    const h = header(html);
    assert.ok(h, `${f}: header`);
    assert.match(h, /class="logo-img"/, f);
    assert.match(h, /id="nav-toggle"/, f);
    assert.match(h, /<nav class="nav" id="site-nav"/, f);
    if (f !== "index") {
      assert.equal(plainHeader(h), ref, `${f}: header matches /quote`);
      assert.match(html, /href="\/site-header\.css"/, f);
    }
    assert.match(html, /<script src="\/nav\.js" defer><\/script>/, f);
  }
});

test("every page has the same footer as the homepage", () => {
  const home = footer(read("index"));
  assert.ok(home, "homepage footer");
  assert.match(home, /EST\. 2025 · Thermopolis, Wyoming/);
  assert.match(home, /https:\/\/www\.youtube\.com\/@PackMuleHouse/);
  assert.match(home, /alt="Pack Mule House logo"/);
  for (const f of PAGES) {
    const html = read(f);
    assert.equal(footer(html), home, `${f}: footer`);
    assert.match(html, /href="\/site-footer\.css"/, f);
    assert.doesNotMatch(html, /class="brand"/, `${f}: old minimal header`);
  }
});
