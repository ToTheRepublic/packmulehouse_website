// Single byte-range support for static assets (needed for Safari/iOS <video>).
// HTML/JS/CSS go through the token/caching path in serveAsset and never reach here.

/** Parse one `bytes=` range against size. Returns {start,end}, "unsatisfiable", or null (ignore -> full 200). */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) {
    // Multi-range or garbage: ignore and send the full body.
    return null;
  }
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  let start, end;
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
    if (b !== "" && Number(b) < start) return null; // invalid -> ignore
  }
  if (start >= size || size === 0) return "unsatisfiable";
  return { start, end };
}

/** Turn a full 200 asset response into 206/416 when the GET request carries a single Range. */
export async function applyRange(request, res) {
  const headers = new Headers(res.headers);
  headers.set("Accept-Ranges", "bytes");
  const rangeHeader = request.method === "GET" ? request.headers.get("Range") : null;
  if (!rangeHeader) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const r = parseRange(rangeHeader, size);
  if (r === null) {
    headers.set("Content-Length", String(size));
    return new Response(buf, { status: 200, headers });
  }
  if (r === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  const part = buf.slice(r.start, r.end + 1);
  headers.set("Content-Range", `bytes ${r.start}-${r.end}/${size}`);
  headers.set("Content-Length", String(part.byteLength));
  return new Response(part, { status: 206, headers });
}
