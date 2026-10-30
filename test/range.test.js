import test from "node:test";
import assert from "node:assert/strict";
import { parseRange, applyRange } from "../src/range.js";

test("parseRange handles single, open-ended, suffix, bad and multi ranges", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=990-5000", 1000), { start: 990, end: 999 });
  assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1,5-9", 1000), null);
  assert.equal(parseRange("items=0-1", 1000), null);
  assert.equal(parseRange(null, 1000), null);
});

const asset = () => new Response(new Uint8Array(1000).map((_, i) => i % 256), {
  headers: { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=3600" },
});
const req = (range) => new Request("https://x.test/a.mp4", range ? { headers: { Range: range } } : {});

test("applyRange returns 206 with Content-Range and keeps headers", async () => {
  const res = await applyRange(req("bytes=0-99"), asset());
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 0-99/1000");
  assert.equal(res.headers.get("Content-Length"), "100");
  assert.equal(res.headers.get("Accept-Ranges"), "bytes");
  assert.equal(res.headers.get("Content-Type"), "video/mp4");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(body.length, 100);
  assert.equal(body[99], 99);
  const tail = await applyRange(req("bytes=-100"), asset());
  assert.equal(tail.headers.get("Content-Range"), "bytes 900-999/1000");
});

test("applyRange: 416 when unsatisfiable, 200 for none or multi-range", async () => {
  const bad = await applyRange(req("bytes=5000-"), asset());
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("Content-Range"), "bytes */1000");
  for (const r of [undefined, "bytes=0-1,5-9"]) {
    const full = await applyRange(req(r), asset());
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("Accept-Ranges"), "bytes");
    assert.equal((await full.arrayBuffer()).byteLength, 1000);
  }
});
