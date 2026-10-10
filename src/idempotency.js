/** Deterministic Square idempotency keys (max 45 chars; we use 32 hex). */

export function parseAttemptId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(id)) return null;
  return id;
}

export async function idempotencyKey(seed, purpose) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pmh-v1:${purpose}:${seed}`)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
