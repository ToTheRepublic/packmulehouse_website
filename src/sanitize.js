/**
 * Neutralize customer-supplied text before it is sent to chat apps.
 * Merchant email keeps the real characters (HTML-escaped separately).
 */

export function discordSafe(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/@(everyone|here)/gi, "@\u200b$1")
    .replace(/<@!?(\d+)>/g, "<@\u200b$1>")
    .replace(/<@&(\d+)>/g, "<@&\u200b$1>")
    .replace(/([\\*_`~|])/g, "\\$1")
    .replace(/\]\(/g, "]\\(");
}

/** Plain text: drop control characters and break mass mentions. */
export function plainSafe(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/@(everyone|here)/gi, "@\u200b$1");
}

export function headerSafe(value, max = 200) {
  return plainSafe(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Telegram treats @word as a mention. Emails keep a broken @ so they don't ping. */
export function telegramSafe(value) {
  return plainSafe(value).replace(/@/g, "@\u200b");
}
