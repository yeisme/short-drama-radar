// Heuristic tagger over available text signals (title first; hook/emotion
// signals from transcripts/captions plug in later). Keyword lists are
// intentionally small and reviewable; v0 optimizes for auditability.
export interface ContentTags {
  hooks: string[];
  hookDensity: number; // 0-5 valid hooks found
  topics: string[];
  emotions: string[];
  emotionIntensity: number; // 1-5
}

const HOOK_KEYWORDS: Record<string, string[]> = {
  identity_reversal: ["身份", "赘婿", "千金", "总裁", "战神", "神医", "逆袭", "马甲"],
  countdown: ["倒计时", "最后", "仅剩", "三天", "一小时"],
  secret_reveal: ["真相", "秘密", "隐瞒", "暴露", "发现"],
  conflict_first: ["离婚", "撕", "打", "报复", "仇恨", "对峙"],
  face_slap: ["打脸", "跪", "后悔", "求"],
  taboo: ["禁忌", "伦理", "出轨", "背叛"],
  suspense_question: ["竟然", "居然", "为什么", "是谁", "没想到"],
};

const TOPIC_KEYWORDS: Record<string, string[]> = {
  revenge: ["复仇", "报复", "打脸", "逆袭", "跪"],
  sweet_romance: ["甜宠", "恋爱", "闪婚", "宠"],
  urban_power: ["都市", "豪门", "商战", "职场", "总裁"],
  family_conflict: ["家庭", "婆媳", "亲情", "遗产"],
  fantasy: ["穿越", "重生", "修仙", "玄幻", "仙侠"],
  suspense: ["悬疑", "推理", "凶案", "失踪"],
};

const EMOTION_KEYWORDS: Record<string, string[]> = {
  anger: ["恨", "撕", "报复", "怒"],
  satisfaction: ["爽", "打脸", "逆袭", "跪"],
  sweetness: ["甜", "宠", "浪漫"],
  fear: ["恐惧", "惊悚", "鬼", "凶"],
  sadness: ["悲", "泪", "虐"],
  curiosity: ["秘密", "真相", "竟然", "没想到", "是谁"],
};

export function tagContent(text: string): ContentTags {
  const hooks = hits(text, HOOK_KEYWORDS);
  const topics = hits(text, TOPIC_KEYWORDS);
  const emotions = hits(text, EMOTION_KEYWORDS);
  return {
    hooks,
    hookDensity: Math.min(5, hooks.length),
    topics,
    emotions,
    emotionIntensity: emotions.length === 0 ? 1 : Math.min(5, 1 + emotions.length),
  };
}

function hits(text: string, table: Record<string, string[]>): string[] {
  const found: string[] = [];
  for (const [tag, keywords] of Object.entries(table)) {
    if (keywords.some((k) => text.includes(k))) found.push(tag);
  }
  return found;
}
