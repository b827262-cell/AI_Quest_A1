// Server-only source URL policy for the public ec.ibrain catalogue.
//
// The upstream form is Big5. Do not replace this encoder with
// encodeURIComponent: that produces UTF-8 bytes and the public form will not
// interpret Chinese keywords correctly. TextDecoder's Big5 table gives this
// server helper a real encoding map without leaking a native executable into
// the request path.

export const PUBLIC_SOURCE_HOST = "ec.ibrain.com.tw";

export const PUBLIC_SOURCE_COL = Object.freeze({
  product_name: "1",
  product_code: "2",
  teacher: "3",
  scope: "7",
});

let big5Map;

function getBig5Map() {
  if (big5Map) return big5Map;
  const decoder = new TextDecoder("big5", { fatal: false });
  const map = new Map();
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (const trail of [...Array.from({ length: 0x7e - 0x40 + 1 }, (_, i) => 0x40 + i),
      ...Array.from({ length: 0xfe - 0xa1 + 1 }, (_, i) => 0xa1 + i)]) {
      const character = decoder.decode(Uint8Array.of(lead, trail));
      if (character.length === 1 && character !== "\uFFFD" && !map.has(character)) {
        map.set(character, [lead, trail]);
      }
    }
  }
  big5Map = map;
  return map;
}

function isAllowedProtocol(url) {
  return url.protocol === "http:" || url.protocol === "https:";
}

/** Returns a canonical exact product page, or null when it is not trustworthy. */
export function normalizeExactProductUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (!isAllowedProtocol(url) || url.hostname.toLowerCase() !== PUBLIC_SOURCE_HOST) return null;
    if (url.username || url.password) return null;
    if (url.pathname.toLowerCase() !== "/publish/www/book.asp") return null;
    const bkid = [...url.searchParams.entries()]
      .find(([name]) => name.toLowerCase() === "bkid")?.[1];
    if (!bkid || !/^\d+$/.test(bkid)) return null;
    return `https://${PUBLIC_SOURCE_HOST}/Publish/www/book.asp?bkid=${bkid}`;
  } catch {
    return null;
  }
}

/** Encodes a keyword as Big5 bytes and percent-escapes every non-unreserved byte. */
export function encodeBig5Percent(keyword) {
  if (typeof keyword !== "string" || keyword.trim() === "") return null;
  const bytes = [];
  const map = getBig5Map();
  for (const character of keyword.trim()) {
    const code = character.codePointAt(0);
    if (code <= 0x7f) {
      bytes.push(code);
      continue;
    }
    const pair = map.get(character);
    if (!pair) {
      // A non-representable keyword is not safe to pretend is Big5.
      return null;
    }
    bytes.push(...pair);
  }
  return [...bytes].map((byte) => (
    (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) || "-._~".includes(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  )).join("");
}

/** Builds the verified stable GET result URL, or null if Big5 conversion failed. */
export function buildStableSearchUrl({ mode = "product_name", keyword } = {}) {
  const col = PUBLIC_SOURCE_COL[mode];
  const encoded = encodeBig5Percent(keyword);
  if (!col || !encoded) return null;
  return `https://${PUBLIC_SOURCE_HOST}/Publish/www/search.asp?PS=30&Col=${col}&keyword=${encoded}&PG=0`;
}

/** Exact product first; otherwise a verified stable search deep link; never homepage. */
export function resolvePublicSourceUrl({ exactUrl, mode, keyword } = {}) {
  return normalizeExactProductUrl(exactUrl) ?? buildStableSearchUrl({ mode, keyword });
}
