export const MARKET_MAPPING_VERSION = "market-label-mapping.v1";

// Exact source labels, not keyword guesses over plot/title prose. Unmatched
// labels are retained so consumers can see the coverage of this small map.
const labels: Record<string, Record<string, string>> = {
  // The hongguo entries below were added from page-evidenced labels of the
  // 2026-09-16 public category sample (hongguo-anchor-layout.v1 fixtures).
  zh: { "复仇": "revenge", "甜宠": "sweet_romance", "悬疑": "suspense", "玄幻": "fantasy", "都市": "urban_power", "家庭": "family_conflict",
    "爱情": "romance", "剧情": "drama", "成长": "growth", "逆袭": "comeback", "古装": "period_costume",
    "都市爱情": "urban_romance", "都市日常": "urban_life", "重生": "rebirth", "重生逆袭": "rebirth_comeback",
    "逆袭翻身": "comeback", "超凡逆袭": "superpowered_comeback", "女性成长": "female_growth",
    "家庭伦理": "family_ethics", "家庭温情": "family_warmth", "年代爱情": "period_romance",
    "奇幻爱情": "fantasy_romance", "古装传奇": "period_legend", "宫斗宅斗": "palace_intrigue",
    "打脸反派": "face_slapping", "读心术": "mind_reading", "先婚后爱": "marriage_before_love",
    "网络暴力": "cyberbullying", "大男主": "male_lead", "日久生情": "slow_burn_romance",
    "逆风翻盘": "underdog_comeback", "暴富": "sudden_wealth", "破镜重圆": "reunion_romance",
    "穿越": "time_travel", "虐渣": "scum_punishment", "真相大白": "truth_revealed",
    "闪婚": "flash_marriage", "商业联姻": "business_marriage", "古灵精怪": "quirky",
    "自我救赎": "self_redemption", "隐藏大佬": "hidden_bigshot" },
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
