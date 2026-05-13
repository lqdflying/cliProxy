import { kvGet, kvSet } from "./kv.js";
import { describeImage } from "./vision.js";
import { createLogger } from "./logger.js";

const { log, diag } = createLogger("vision");

// By default only data: URIs are accepted — they carry the inlined image
// bytes and never trigger a network fetch by the upstream vision provider.
// Allowing http/https here turns the proxy into an indirection that lets a
// client hand an arbitrary URL (including cloud metadata or RFC1918
// addresses) to the upstream's network. Operators who need remote-URL
// image references must opt in via VISION_ALLOW_REMOTE_URLS=true; even
// then loopback / link-local / private-network hosts are rejected.
//
// NOTE: the remote-URL check below is a literal-hostname filter. We do
// not resolve DNS, follow redirects, or know the IP that the upstream
// vision backend will actually connect to. A public hostname that
// resolves to a private address, or a public URL that 30x-redirects to
// one, will still reach the upstream. Document this limitation in
// doc/vision-bridge.md and prefer data: URIs when the threat model
// requires DNS / redirect validation.
const ALLOW_REMOTE_IMAGE_URLS = process.env.VISION_ALLOW_REMOTE_URLS === "true";

function parseIPv4(s) {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [+m[1], +m[2], +m[3], +m[4]];
  for (const p of parts) if (p > 255) return null;
  return parts;
}

function isBlockedIPv4(parts) {
  const [a, b] = parts;
  if (a === 0) return true;                    // 0.0.0.0/8
  if (a === 10) return true;                   // RFC1918
  if (a === 127) return true;                  // loopback
  if (a === 169 && b === 254) return true;     // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;     // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                   // multicast + reserved
  return false;
}

// Parse an IPv6 literal (without brackets, lowercased) to an 8-hextet array.
// Also accepts a trailing dotted-IPv4 suffix (RFC 4291 §2.2 form 3). Returns
// null on parse failure. Critically, Node's URL canonicalizes the dotted
// suffix into hex hextets (e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1), so we
// must reason about the hex form, not just the dotted form.
function parseIPv6(h) {
  if (typeof h !== "string" || h.length === 0) return null;
  // Optional trailing IPv4 (rare, since URL.hostname normalizes it away).
  let dotted = null;
  const dotIdx = h.lastIndexOf(".");
  if (dotIdx >= 0) {
    const lastColon = h.lastIndexOf(":");
    if (lastColon < 0 || lastColon > dotIdx) return null;
    dotted = parseIPv4(h.slice(lastColon + 1));
    if (!dotted) return null;
    h = h.slice(0, lastColon + 1) + ((dotted[0] << 8) | dotted[1]).toString(16) + ":" + ((dotted[2] << 8) | dotted[3]).toString(16);
  }
  if (!/^[0-9a-f:]+$/.test(h)) return null;
  const dd = h.indexOf("::");
  if (dd !== h.lastIndexOf("::")) return null; // at most one "::"
  let head, tail;
  if (dd < 0) {
    head = h.split(":");
    tail = [];
  } else {
    const before = h.slice(0, dd);
    const after = h.slice(dd + 2);
    head = before ? before.split(":") : [];
    tail = after ? after.split(":") : [];
  }
  const validHex = (xs) => xs.every((x) => /^[0-9a-f]{1,4}$/.test(x));
  if (!validHex(head) || !validHex(tail)) return null;
  const provided = head.length + tail.length;
  if (provided > 8) return null;
  if (dd < 0 && provided !== 8) return null;
  const zeros = 8 - provided;
  const hex = [...head, ...new Array(zeros).fill("0"), ...tail].map((x) => parseInt(x, 16));
  if (hex.length !== 8 || hex.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
  return hex;
}

function isBlockedIPv6(hex) {
  if (hex.every((n) => n === 0)) return true;            // ::
  if (hex.slice(0, 7).every((n) => n === 0) && hex[7] === 1) return true; // ::1

  // Link-local fe80::/10, ULA fc00::/7, multicast ff00::/8 — first hextet.
  const f = hex[0];
  if (f >= 0xfe80 && f <= 0xfebf) return true;
  if (f >= 0xfc00 && f <= 0xfdff) return true;
  if (f >= 0xff00 && f <= 0xffff) return true;

  // Recognized IPv4-in-IPv6 prefixes — extract IPv4 from the last two
  // hextets and recurse to the IPv4 blocklist. This is the critical case
  // that catches the Node-normalized form of ::ffff:127.0.0.1 etc.
  const innerV4 = () => {
    const hi = hex[6], lo = hex[7];
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  };
  const head6Zero = hex[0] === 0 && hex[1] === 0 && hex[2] === 0 && hex[3] === 0 && hex[4] === 0 && hex[5] === 0;
  const isMapped     = hex[0] === 0 && hex[1] === 0 && hex[2] === 0 && hex[3] === 0 && hex[4] === 0 && hex[5] === 0xffff;
  const isTranslated = hex[0] === 0 && hex[1] === 0 && hex[2] === 0 && hex[3] === 0 && hex[4] === 0xffff && hex[5] === 0;
  const isNat64      = hex[0] === 0x64 && hex[1] === 0xff9b && hex[2] === 0 && hex[3] === 0 && hex[4] === 0 && hex[5] === 0;
  if (head6Zero || isMapped || isTranslated || isNat64) {
    if (isBlockedIPv4(innerV4())) return true;
  }
  // 6to4 (2002::/16): embedded IPv4 lives in hex[1..2].
  if (hex[0] === 0x2002) {
    const v4 = [(hex[1] >> 8) & 0xff, hex[1] & 0xff, (hex[2] >> 8) & 0xff, hex[2] & 0xff];
    if (isBlockedIPv4(v4)) return true;
  }

  return false;
}

function isBlockedRemoteHost(rawHost) {
  if (!rawHost) return true;
  let h = String(rawHost).toLowerCase();
  // URL.hostname returns IPv6 literals wrapped in brackets — strip them.
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // DNS root trailing dots: 'localhost.' is the same target as 'localhost'.
  while (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "" || h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;

  // IPv4 literal
  const v4 = parseIPv4(h);
  if (v4) return isBlockedIPv4(v4);

  // IPv6 literal (URL.hostname for non-IPv6 names never contains ':')
  if (h.includes(":")) {
    const hex = parseIPv6(h);
    if (!hex) return true; // unparseable IPv6 — refuse rather than guess
    return isBlockedIPv6(hex);
  }

  return false;
}

function isAllowedImageUrl(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  if (url.startsWith("data:")) return true;
  if (!ALLOW_REMOTE_IMAGE_URLS) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (isBlockedRemoteHost(parsed.hostname)) return false;
  return true;
}

/**
 * Convert image content to text descriptions using the configured vision API.
 * Caches descriptions by image hash in KV to avoid re-processing.
 *
 * @param {Array} messages - The messages array from the request body.
 * @param {Function} sha256ImageHash - image hashing helper
 * @returns {Promise<{messages: Array, convertedCount: number, errors: number, rejectedCount: number}>}
 */
async function convertImagesToText(messages, sha256ImageHash) {
  let convertedCount = 0;
  let errors = 0;
  let rejectedCount = 0;

  // Flatten all image_url parts to process them with bounded concurrency
  const replacements = []; // { msgIdx, partIdx, imageUrl }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user" && m.role !== "system") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;

    for (let j = 0; j < content.length; j++) {
      const part = content[j];
      if (part?.type !== "image_url") continue;

      const imageUrl = part.image_url?.url;
      if (!imageUrl) continue;

      if (!isAllowedImageUrl(imageUrl)) {
        diag("VISION_REJECTED_URL", "scheme not allowed; len:", imageUrl.length);
        replacements.push({ msgIdx: i, partIdx: j, imageUrl, rejected: true });
        continue;
      }

      replacements.push({ msgIdx: i, partIdx: j, imageUrl });
    }
  }

  if (replacements.length === 0) {
    return { messages, convertedCount: 0, errors: 0, rejectedCount: 0 };
  }

  if (replacements.length > 1) {
    let totalBytes = 0;
    for (const r of replacements) totalBytes += r.imageUrl.length;
    log("VISION_BATCH", "images:", replacements.length, "totalUriBytes:", totalBytes);
  }

  // Bounded concurrency: vision endpoints (e.g. MiniMax-VL-01) rate-limit on
  // bursts. Cache hits short-circuit before the network call so this only
  // throttles real upstream requests. Override via VISION_CONCURRENCY env.
  const concurrency = (() => {
    const raw = parseInt(process.env.VISION_CONCURRENCY || "", 10);
    if (Number.isFinite(raw) && raw >= 1) return raw;
    return 2;
  })();

  const processOne = async ({ msgIdx, partIdx, imageUrl, rejected }) => {
    if (rejected) {
      return { msgIdx, partIdx, description: null, error: "unsupported image URL scheme", rejected: true };
    }
    try {
      const cacheKey = await sha256ImageHash(imageUrl);
      const cached = await kvGet(cacheKey);
      if (cached) {
        return { msgIdx, partIdx, description: cached, fromCache: true };
      }

      const description = await describeImage(imageUrl);
      if (description) {
        await kvSet(cacheKey, description).catch(() => {});
      }
      return { msgIdx, partIdx, description, fromCache: false };
    } catch (err) {
      // Always-on: vision failures must be visible in production so operators
      // notice when a key/quota/oversized payload is breaking multi-image runs.
      diag("VISION_ERROR", err?.message);
      return { msgIdx, partIdx, description: null, error: err?.message };
    }
  };

  const results = new Array(replacements.length);
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, replacements.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= replacements.length) return;
        results[idx] = await processOne(replacements[idx]);
      }
    });
  await Promise.all(workers);

  // Apply replacements to a mutable copy of messages
  const updated = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));

  for (const r of results) {
    const { msgIdx, partIdx, description, error } = r;
    if (description) {
      updated[msgIdx].content[partIdx] = {
        type: "text",
        text: "[Image content: " + description + "]",
      };
      convertedCount++;
      log("VISION_CONVERTED", "msg:", msgIdx, "part:", partIdx, "cached:", r.fromCache);
    } else {
      updated[msgIdx].content[partIdx] = {
        type: "text",
        text: "(image attachment unavailable" + (error ? ": " + error : "") + ")",
      };
      if (r.rejected) rejectedCount++;
      else errors++;
    }
  }

  // Merge consecutive text parts and (when no image_url remains) collapse to a
  // single string. DeepSeek / MiniMax non-vision chat endpoints are not
  // reliable about reading the 2nd+ entry of a multi-part text content array,
  // so leaving N separate {type:"text"} parts for N images causes only the
  // first description to be read by the model. Only touch user/system turns
  // we already rewrote — never assistant history.
  for (let i = 0; i < updated.length; i++) {
    const m = updated[i];
    if (m.role !== "user" && m.role !== "system") continue;
    if (!Array.isArray(m.content)) continue;

    const hasImages = m.content.some((p) => p?.type === "image_url");

    if (!hasImages) {
      const joined = m.content
        .map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text : ""))
        .filter((s) => typeof s === "string" && s.length > 0)
        .join("\n\n");
      m.content = joined.length > 0 ? joined : "(image attachment unavailable)";
      continue;
    }

    // image_url parts still present (vision-capable provider edge case): at
    // least merge runs of consecutive text parts into one.
    const merged = [];
    for (const p of m.content) {
      const isText = typeof p === "string" || p?.type === "text";
      const last = merged[merged.length - 1];
      if (isText && last && (typeof last === "string" || last.type === "text")) {
        const lastText = typeof last === "string" ? last : last.text;
        const curText = typeof p === "string" ? p : p.text;
        merged[merged.length - 1] = {
          type: "text",
          text: (lastText || "") + "\n\n" + (curText || ""),
        };
      } else {
        merged.push(p);
      }
    }
    m.content = merged;
  }

  return { messages: updated, convertedCount, errors, rejectedCount };
}

export { convertImagesToText };
