import { createHash } from "node:crypto";

// X-Bogus signer — native TypeScript port of the publicly reverse-engineered
// algorithm (Evil0ctal / Douyin_TikTok_Download_API, Apache-2.0). Signing is
// deterministic given (query, user agent, unix seconds); verification vectors
// live in test/unit/xbogus.test.ts.

const CHARACTER = "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=";
const UA_KEY = Uint8Array.of(0x00, 0x01, 0x0c);

// Hex-digit lookup table: value 0-15 for chars '0'-'9' and 'a'-'f'.
const HEX_TABLE = buildHexTable();

function buildHexTable(): (number | null)[] {
  const table: (number | null)[] = new Array(123).fill(null);
  for (let i = 0; i <= 9; i++) table[48 + i] = i; // '0'-'9'
  for (let i = 0; i <= 5; i++) table[97 + i] = 10 + i; // 'a'-'f'
  return table;
}

// md5_str_to_array: >32 chars are treated as raw text (char codes), shorter
// strings as hex pairs.
function md5StrToArray(input: string): number[] {
  if (input.length > 32) {
    const codes: number[] = [];
    for (let i = 0; i < input.length; i++) codes.push(input.charCodeAt(i) & 0xff);
    return codes;
  }
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 2) {
    const hi = HEX_TABLE[input.charCodeAt(i)];
    const lo = HEX_TABLE[input.charCodeAt(i + 1)];
    bytes.push(((hi ?? 0) << 4) | (lo ?? 0));
  }
  return bytes;
}

function md5(data: number[] | string): string {
  const bytes = typeof data === "string" ? md5StrToArray(data) : data;
  return createHash("md5").update(Buffer.from(bytes)).digest("hex");
}

function md5Encrypt(url: string): number[] {
  return md5StrToArray(md5(md5StrToArray(md5(url))));
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) % 256;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) % 256;
    j = (j + s[a]!) % 256;
    [s[a], s[j]] = [s[j]!, s[a]!];
    out[k] = data[k]! ^ s[(s[a]! + s[j]!) % 256]!;
  }
  return out;
}

function calculation(a: number, b: number, c: number): string {
  const x3 = ((a & 255) << 16) | ((b & 255) << 8) | (c & 255);
  return (
    CHARACTER[(x3 & 16515072) >> 18]! +
    CHARACTER[(x3 & 258048) >> 12]! +
    CHARACTER[(x3 & 4032) >> 6]! +
    CHARACTER[x3 & 63]!
  );
}

export const DOUYIN_WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export function generateXBogus(query: string, userAgent: string = DOUYIN_WEB_UA, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const uaMd5 = md5StrToArray(
    md5(Buffer.from(rc4(UA_KEY, Uint8Array.from(Array.from(userAgent, (ch) => ch.charCodeAt(0) & 0xff)))).toString("base64")),
  );
  const emptyMd5 = md5StrToArray(md5(md5StrToArray("d41d8cd98f00b204e9800998ecf8427e")));
  const urlMd5 = md5Encrypt(query);

  const timer = nowSec;
  const ct = 536919696;
  const newArray: number[] = [
    64,
    0.00390625,
    1,
    12,
    urlMd5[14]!,
    urlMd5[15]!,
    emptyMd5[14]!,
    emptyMd5[15]!,
    uaMd5[14]!,
    uaMd5[15]!,
    (timer >> 24) & 255,
    (timer >> 16) & 255,
    (timer >> 8) & 255,
    timer & 255,
    (ct >> 24) & 255,
    (ct >> 16) & 255,
    (ct >> 8) & 255,
    ct & 255,
  ];

  let xorResult = newArray[0]!;
  for (let i = 1; i < newArray.length; i++) {
    xorResult ^= Math.trunc(newArray[i]!);
  }
  newArray.push(xorResult);

  // Interleave into odd/even halves, then apply the upstream byte permutation.
  const array3: number[] = [];
  const array4: number[] = [];
  for (let i = 0; i < newArray.length; i++) {
    if (i % 2 === 0) array3.push(newArray[i]!);
    else array4.push(newArray[i]!);
  }
  const merged = [...array3, ...array4];

  const payload = Uint8Array.from([
    merged[0]!,
    Math.trunc(merged[10]!),
    merged[1]!,
    merged[11]!,
    merged[2]!,
    merged[12]!,
    merged[3]!,
    merged[13]!,
    merged[4]!,
    merged[14]!,
    merged[5]!,
    merged[15]!,
    merged[6]!,
    merged[16]!,
    merged[7]!,
    merged[17]!,
    merged[8]!,
    merged[18]!,
    merged[9]!,
  ]);

  const cipher = rc4(Uint8Array.of(0xff), payload); // key "ÿ" in latin1
  const garbled = [2, 255, ...cipher];

  let xb = "";
  for (let i = 0; i < garbled.length; i += 3) {
    xb += calculation(garbled[i]!, garbled[i + 1]!, garbled[i + 2]!);
  }
  return xb;
}

export function signUrl(query: string, userAgent: string = DOUYIN_WEB_UA, nowSec?: number): string {
  return `${query}&X-Bogus=${generateXBogus(query, userAgent, nowSec)}`;
}
