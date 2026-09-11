export const MARKET_MAPPING_VERSION = "market-label-mapping.v1";

// Exact source labels, not keyword guesses over plot/title prose. Unmatched
// labels are retained so consumers can see the coverage of this small map.
const labels: Record<string, Record<string, string>> = {
  zh: { "复仇": "revenge", "甜宠": "sweet_romance", "悬疑": "suspense", "玄幻": "fantasy", "都市": "urban_power", "家庭": "family_conflict" },
  en: { revenge: "revenge", romance: "sweet_romance", "sweet love": "sweet_romance", mystery: "suspense", suspense: "suspense", fantasy: "fantasy", urban: "urban_power", family: "family_conflict" },
  es: { venganza: "revenge", romance: "sweet_romance", misterio: "suspense", fantasía: "fantasy", familia: "family_conflict" },
  pt: { vingança: "revenge", romance: "sweet_romance", mistério: "suspense", fantasia: "fantasy", família: "family_conflict" },
  id: { "balas dendam": "revenge", romansa: "sweet_romance", misteri: "suspense", fantasi: "fantasy", keluarga: "family_conflict" },
  hi: { "बदला": "revenge", "रोमांस": "sweet_romance", "रहस्य": "suspense", "फंतासी": "fantasy", "परिवार": "family_conflict" },
};

export function classifyLabels(input: { locale: string; labels: string[] }) {
  if (typeof input.locale !== "string" || !Array.isArray(input.labels) || input.labels.length > 100 ||
    input.labels.some(label => typeof label !== "string" || label.length > 120 || /[\u0000-\u001f\u007f]/u.test(label))) {
    throw new Error("Invalid classification labels.");
  }
  const language = input.locale.toLowerCase().split("-")[0];
  const table = labels[language] ?? {};
  const matched: Array<{ label: string; topic: string }> = [];
  const unknown: string[] = [];
  for (const label of input.labels) {
    const normalized = label.normalize("NFKC").trim().toLowerCase();
    const topic = Object.hasOwn(table, normalized) ? table[normalized] : undefined;
    if (topic) matched.push({ label, topic });
    else unknown.push(label);
  }
  return { mapping_version: MARKET_MAPPING_VERSION, topics: [...new Set(matched.map(m => m.topic))].sort(),
    matched, unknown_labels: unknown, status: unknown.length ? "partial" : matched.length ? "mapped" : "unknown" };
}
