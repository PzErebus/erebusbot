import { MemoryCache } from './cache';
import { createLogger } from './logger';

const log = createLogger('ad-filter');

export interface AdFilterResult {
  isAd: boolean;
  score: number;
  reasons: string[];
  action: 'allow' | 'warn' | 'block' | 'shadow_block';
  aiScore?: number;
}

export interface AdFilterConfig {
  enabled: boolean;
  threshold: number;
  strictThreshold: number;
  autoBlock: boolean;
  warnFirst: boolean;
  maxWarnings: number;
  frequencyLimit: number;
  frequencyWindow: number;
  aiEnabled: boolean;
  aiThreshold: number;
}

const DEFAULT_CONFIG: AdFilterConfig = {
  enabled: true,
  threshold: 50,
  strictThreshold: 80,
  autoBlock: false,
  warnFirst: true,
  maxWarnings: 3,
  frequencyLimit: 5,
  frequencyWindow: 60,
  aiEnabled: true,
  aiThreshold: 60,
};

const PROMOTION_PATTERNS: Array<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /(?:加|添|➕)\s*(?:微信|v|vx|薇信|威信|薇|v信)/i, score: 40, reason: '推广微信' },
  { pattern: /(?:微信|v|vx|薇信|威信|薇|v信)\s*(?:号|ID|:|：)/i, score: 35, reason: '微信号码' },
  { pattern: /(?:qq|QQ)\s*(?:号|群|:|：)/i, score: 30, reason: '推广QQ' },
  { pattern: /(?:telegram|tg|电报)\s*(?:群|频道|channel|:|：)/i, score: 25, reason: '推广Telegram' },
  { pattern: /(?:加|进|入)\s*(?:群|频道|群组)/i, score: 15, reason: '引流加群' },
  { pattern: /(?:免费|限时|特价|优惠|折扣|打折|促销|秒杀|抢购)/i, score: 20, reason: '促销用语' },
  { pattern: /(?:原价|现价|到手价|券后价|活动价)/i, score: 20, reason: '价格促销' },
  { pattern: /(?:赚钱|日赚|月入|躺赚|暴富|副业|兼职)/i, score: 25, reason: '赚钱诱导' },
  { pattern: /(?:投资|理财|收益|回报|分红|返利|返佣)/i, score: 25, reason: '投资理财' },
  { pattern: /(?:赌|博彩|彩票|开奖|下注|押注|盘口)/i, score: 40, reason: '赌博推广' },
  { pattern: /(?:色|约炮|同城|上门|服务|按摩|特殊)/i, score: 35, reason: '色情暗示' },
  { pattern: /(?:代购|代发|代刷|代充|代练|代写)/i, score: 20, reason: '代购代刷' },
  { pattern: /(?:出售|售卖|卖|转让|清仓|甩卖)/i, score: 15, reason: '出售商品' },
  { pattern: /(?:招代理|招加盟|招商|招募合伙人)/i, score: 30, reason: '招代理加盟' },
  { pattern: /(?:刷单|刷评|刷量|刷粉|刷赞)/i, score: 35, reason: '刷单推广' },
  { pattern: /(?:课程|培训|教学|一对一|私教).*(?:报名|咨询|了解)/i, score: 20, reason: '培训推广' },
  { pattern: /(?:点击|戳|复制|打开).*(?:链接|网址|网站|链接)/i, score: 20, reason: '引流点击' },
  { pattern: /(?:名额有限|仅剩|最后|手慢无|先到先得)/i, score: 15, reason: '饥饿营销' },
  { pattern: /(?:包赚|稳赚|必赚|零风险|无风险)/i, score: 30, reason: '虚假承诺' },
  { pattern: /(?:拉黑|删除|屏蔽|举报).*(?:防|免|避免)/i, score: 10, reason: '反屏蔽话术' },
];

const URL_PATTERNS: Array<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi, score: 15, reason: '包含URL' },
  { pattern: /(?:www\.|\.com|\.cn|\.net|\.org|\.io|\.cc|\.me|\.top|\.xyz|\.vip)/i, score: 12, reason: '包含域名' },
  { pattern: /(?:t\.me|telegram\.me|tg\.me)\/\S+/i, score: 20, reason: 'Telegram链接' },
  { pattern: /(?:bit\.ly|tinyurl|shorturl|dwz\.cn|suo\.im|t\.cn|url\.cn)\/\S+/i, score: 25, reason: '短链接' },
];

const CONTACT_PATTERNS: Array<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /(?:1[3-9])\d{9}/, score: 15, reason: '手机号码' },
  { pattern: /(?:微信|v|vx|薇)\s*(?::|：)?\s*[a-zA-Z0-9_-]{5,20}/i, score: 30, reason: '微信号' },
  { pattern: /(?:QQ|qq)\s*(?::|：)?\s*\d{5,12}/i, score: 25, reason: 'QQ号' },
  { pattern: /(?:telegram|tg)\s*(?::|：)?\s*@[a-zA-Z0-9_]{5,}/i, score: 20, reason: 'Telegram用户名' },
  { pattern: /@\w{3,}/, score: 8, reason: '@用户名' },
];

const STRUCTURE_PATTERNS: Array<{ check: (text: string) => number; reason: string }> = [
  {
    check: (text: string) => {
      const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
      const textLen = text.replace(/\s/g, '').length;
      if (textLen > 0 && emojiCount / textLen > 0.3) return 10;
      return 0;
    },
    reason: '表情符号过多'
  },
  {
    check: (text: string) => {
      const lines = text.split(/\n/).filter(l => l.trim());
      if (lines.length > 8) return 10;
      return 0;
    },
    reason: '多行排版'
  },
  {
    check: (text: string) => {
      const hasArrow = /[→➡▶►]/.test(text);
      const hasBox = /[┌┐└┘│─┬┴├┤┼]/.test(text);
      if (hasArrow && hasBox) return 8;
      return 0;
    },
    reason: '广告排版格式'
  },
  {
    check: (text: string) => {
      const pricePattern = /[\d,]+\.?\d*\s*(?:元|块|¥|￥|\$)/;
      if (pricePattern.test(text)) return 8;
      return 0;
    },
    reason: '包含价格'
  },
];

interface UserFrequency {
  count: number;
  windowStart: number;
  warnings: number;
  lastAdScore: number;
}

const AI_SYSTEM_PROMPT = `你是一个广告检测助手。判断用户消息是否为广告/推广/垃圾信息。

判断标准：
- 包含推广联系方式（微信、QQ、Telegram等）
- 推销商品或服务
- 引流到外部平台
- 传销/赌博/色情等违法内容
- 刷单、代购等灰色服务
- 夸大宣传、虚假承诺

正常对话包括：
- 普通咨询、提问
- 正常聊天、问候
- 合理的产品反馈或建议
- 技术问题求助

请严格按以下JSON格式回复，不要输出任何其他内容：
{"is_ad":true/false,"score":0-100,"reason":"简短原因"}`;

const AI_MODEL = 'Qwen/Qwen2.5-7B-Instruct';
const AI_API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const AI_TIMEOUT_MS = 5000;
const AI_CACHE_TTL = 300;

export class AdFilter {
  private config: AdFilterConfig;
  private cache: MemoryCache;
  private apiKey: string | null = null;
  private compiledPromoPatterns: Array<{ compiled: RegExp; score: number; reason: string }>;
  private compiledUrlPatterns: Array<{ compiled: RegExp; score: number; reason: string }>;
  private compiledContactPatterns: Array<{ compiled: RegExp; score: number; reason: string }>;

  constructor(cache: MemoryCache, config?: Partial<AdFilterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = cache;

    this.compiledPromoPatterns = PROMOTION_PATTERNS.map(p => ({
      compiled: new RegExp(p.pattern.source, p.pattern.flags),
      score: p.score,
      reason: p.reason,
    }));

    this.compiledUrlPatterns = URL_PATTERNS.map(p => ({
      compiled: new RegExp(p.pattern.source, p.pattern.flags),
      score: p.score,
      reason: p.reason,
    }));

    this.compiledContactPatterns = CONTACT_PATTERNS.map(p => ({
      compiled: new RegExp(p.pattern.source, p.pattern.flags),
      score: p.score,
      reason: p.reason,
    }));
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  async check(text: string, userId: number): Promise<AdFilterResult> {
    if (!this.config.enabled) {
      return { isAd: false, score: 0, reasons: [], action: 'allow' };
    }

    const ruleResult = this.ruleCheck(text, userId);

    if (ruleResult.score >= this.config.strictThreshold) {
      return this.determineAction(ruleResult.score, ruleResult.reasons, userId, undefined);
    }

    if (this.config.aiEnabled && this.apiKey && ruleResult.score < this.config.threshold) {
      const aiResult = await this.aiCheck(text);
      if (aiResult !== null) {
        const combinedScore = Math.min(100, ruleResult.score + aiResult.score);
        if (aiResult.isAd && combinedScore >= this.config.aiThreshold) {
          const reasons = [...ruleResult.reasons];
          if (aiResult.reason && !reasons.includes(aiResult.reason)) {
            reasons.push(aiResult.reason);
          }
          return this.determineAction(combinedScore, reasons, userId, aiResult.score);
        }
        return { isAd: false, score: combinedScore, reasons: ruleResult.reasons, action: 'allow', aiScore: aiResult.score };
      }
    }

    return this.determineAction(ruleResult.score, ruleResult.reasons, userId, undefined);
  }

  private ruleCheck(text: string, userId: number): { score: number; reasons: string[] } {
    let totalScore = 0;
    const reasons: string[] = [];
    const matchedReasons = new Set<string>();

    for (const p of this.compiledPromoPatterns) {
      if (p.compiled.test(text)) {
        totalScore += p.score;
        if (!matchedReasons.has(p.reason)) {
          matchedReasons.add(p.reason);
          reasons.push(p.reason);
        }
        p.compiled.lastIndex = 0;
      }
    }

    for (const p of this.compiledUrlPatterns) {
      if (p.compiled.test(text)) {
        totalScore += p.score;
        if (!matchedReasons.has(p.reason)) {
          matchedReasons.add(p.reason);
          reasons.push(p.reason);
        }
        p.compiled.lastIndex = 0;
      }
    }

    for (const p of this.compiledContactPatterns) {
      if (p.compiled.test(text)) {
        totalScore += p.score;
        if (!matchedReasons.has(p.reason)) {
          matchedReasons.add(p.reason);
          reasons.push(p.reason);
        }
        p.compiled.lastIndex = 0;
      }
    }

    for (const sp of STRUCTURE_PATTERNS) {
      const s = sp.check(text);
      if (s > 0) {
        totalScore += s;
        if (!matchedReasons.has(sp.reason)) {
          matchedReasons.add(sp.reason);
          reasons.push(sp.reason);
        }
      }
    }

    const freqResult = this.checkFrequency(userId);
    if (freqResult.isFrequent) {
      totalScore += 15;
      reasons.push(`频繁发送(${freqResult.count}条/${this.config.frequencyWindow}秒)`);
    }

    totalScore = Math.min(totalScore, 100);

    return { score: totalScore, reasons };
  }

  private async aiCheck(text: string): Promise<{ isAd: boolean; score: number; reason: string } | null> {
    if (text.length < 4 || text.length > 2000) return null;

    const cacheKey = `aiad:${this.simpleHash(text)}`;
    const cached = this.cache.get<{ isAd: boolean; score: number; reason: string }>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

      const response = await fetch(AI_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: 'system', content: AI_SYSTEM_PROMPT },
            { role: 'user', content: text.substring(0, 500) },
          ],
          temperature: 0.1,
          max_tokens: 100,
          stream: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        log.warn('AI ad check API error', { status: response.status });
        return null;
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = this.parseAIResponse(content);
      if (parsed) {
        this.cache.set(cacheKey, parsed, AI_CACHE_TTL);
      }
      return parsed;
    } catch (e) {
      log.warn('AI ad check failed', { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  private parseAIResponse(content: string): { isAd: boolean; score: number; reason: string } | null {
    try {
      const jsonMatch = content.match(/\{[\s\S]*?"is_ad"[\s\S]*?"score"[\s\S]*?"reason"[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const obj = JSON.parse(jsonMatch[0]);
      const isAd = Boolean(obj.is_ad);
      const score = typeof obj.score === 'number' ? Math.max(0, Math.min(100, obj.score)) : (isAd ? 70 : 0);
      const reason = typeof obj.reason === 'string' ? obj.reason : (isAd ? 'AI检测为广告' : '');

      return { isAd, score, reason };
    } catch {
      return null;
    }
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  private determineAction(score: number, reasons: string[], userId: number, aiScore?: number): AdFilterResult {
    const isAd = score >= this.config.threshold;
    const isStrict = score >= this.config.strictThreshold;

    let action: AdFilterResult['action'] = 'allow';
    if (isAd) {
      const userFreq = this.getUserFrequency(userId);

      if (isStrict && this.config.autoBlock) {
        action = 'shadow_block';
      } else if (this.config.warnFirst && userFreq.warnings < this.config.maxWarnings) {
        action = 'warn';
        userFreq.warnings++;
        this.setUserFrequency(userId, userFreq);
      } else {
        action = 'block';
      }
    }

    if (isAd) {
      const userFreq = this.getUserFrequency(userId);
      userFreq.lastAdScore = score;
      this.setUserFrequency(userId, userFreq);
    }

    log.info('Ad filter check', {
      userId,
      score,
      isAd,
      action,
      reasons: reasons.join(','),
      aiScore: aiScore ?? 'N/A',
    });

    return { isAd, score, reasons, action, aiScore };
  }

  private checkFrequency(userId: number): { isFrequent: boolean; count: number } {
    const freq = this.getUserFrequency(userId);
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / this.config.frequencyWindow) * this.config.frequencyWindow;

    if (freq.windowStart !== windowStart) {
      freq.count = 1;
      freq.windowStart = windowStart;
    } else {
      freq.count++;
    }

    this.setUserFrequency(userId, freq);

    return {
      isFrequent: freq.count > this.config.frequencyLimit,
      count: freq.count,
    };
  }

  private getUserFrequency(userId: number): UserFrequency {
    const key = `adfreq:${userId}`;
    const cached = this.cache.get<UserFrequency>(key);
    if (cached !== undefined) return { ...cached };
    return { count: 0, windowStart: 0, warnings: 0, lastAdScore: 0 };
  }

  private setUserFrequency(userId: number, freq: UserFrequency): void {
    const key = `adfreq:${userId}`;
    this.cache.set(key, freq, this.config.frequencyWindow * 2);
  }

  resetUserWarnings(userId: number): void {
    const freq = this.getUserFrequency(userId);
    freq.warnings = 0;
    freq.lastAdScore = 0;
    this.setUserFrequency(userId, freq);
  }

  getUserStats(userId: number): { warnings: number; lastAdScore: number } {
    const freq = this.getUserFrequency(userId);
    return { warnings: freq.warnings, lastAdScore: freq.lastAdScore };
  }

  updateConfig(config: Partial<AdFilterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): AdFilterConfig {
    return { ...this.config };
  }
}
