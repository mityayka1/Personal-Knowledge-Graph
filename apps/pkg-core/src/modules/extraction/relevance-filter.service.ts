import { Injectable, Logger } from '@nestjs/common';

export interface RelevanceResult {
  isRelevant: boolean;
  score: number;
  suggestedTypes: string[];
  matchedPatterns: string[];
}

/**
 * Local relevance filter to reduce LLM calls.
 * Filters messages before sending to Claude for extraction.
 *
 * Criteria:
 * - Contains extractable patterns (phone, email, @username)
 * - Contains keywords about work, meetings, commitments
 * - Long enough to contain meaningful info
 */
@Injectable()
export class RelevanceFilterService {
  private readonly logger = new Logger(RelevanceFilterService.name);

  // Keywords by category
  private readonly KEYWORDS: Record<string, string[]> = {
    position: [
      'должность', 'работаю', 'назначили', 'директор', 'менеджер',
      'руководитель', 'специалист', 'инженер', 'разработчик', 'аналитик',
      'position', 'role', 'job', 'work as', 'hired as',
    ],
    company: [
      'компания', 'организация', 'перешёл в', 'устроился', 'работаю в',
      'company', 'organization', 'joined', 'working at', 'employed',
    ],
    meeting: [
      'встреча', 'созвон', 'давай в', 'завтра в', 'сегодня в',
      'meeting', 'call', 'let\'s meet', 'zoom', 'teams',
      'понедельник', 'вторник', 'среда', 'четверг', 'пятница',
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
    ],
    deadline: [
      'дедлайн', 'срок', 'до конца', 'к понедельнику', 'к пятнице',
      'deadline', 'due date', 'by end of', 'until', 'before',
    ],
    commitment: [
      'договорились', 'обещал', 'сделаю', 'пришлю', 'отправлю',
      'скину', 'напишу', 'позвоню', 'свяжусь',
      'agreed', 'promised', 'will do', 'will send', 'i\'ll',
    ],
    contact: [
      'телефон', 'номер', 'позвони', 'напиши', 'мой контакт',
      'phone', 'number', 'call me', 'reach me', 'contact',
    ],
    personal: [
      'день рождения', 'родился', 'женат', 'замужем', 'дети',
      'birthday', 'born', 'married', 'kids', 'family',
      'хобби', 'увлечение', 'люблю', 'интересуюсь',
      'hobby', 'interest', 'like', 'enjoy',
    ],
    location: [
      'живу в', 'переехал', 'нахожусь', 'город', 'адрес',
      'live in', 'moved to', 'located', 'city', 'address',
    ],
  };

  // Extractable patterns (regex)
  private readonly PATTERNS: Record<string, RegExp> = {
    phone: /\+?\d[\d\s\-\(\)]{9,}/g,
    email: /[\w.\-]+@[\w.\-]+\.\w{2,}/gi,
    telegram: /@[\w_]{4,}/g,
    time: /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g,
    date: /\b(\d{1,2})[.\/-](\d{1,2})([.\/-](\d{2,4}))?\b/g,
  };

  // Minimum message length for relevance
  private readonly MIN_LENGTH = 15;

  // Score thresholds
  private readonly RELEVANCE_THRESHOLD = 0.3;

  /**
   * Check if a message is relevant for fact extraction
   */
  checkRelevance(content: string): RelevanceResult {
    if (!content || content.length < this.MIN_LENGTH) {
      return {
        isRelevant: false,
        score: 0,
        suggestedTypes: [],
        matchedPatterns: [],
      };
    }

    const lowerContent = content.toLowerCase();
    const matchedPatterns: string[] = [];
    const suggestedTypes: Set<string> = new Set();
    let score = 0;

    // Check patterns (high value)
    for (const [patternName, regex] of Object.entries(this.PATTERNS)) {
      const matches = content.match(regex);
      if (matches && matches.length > 0) {
        matchedPatterns.push(`${patternName}:${matches.length}`);
        score += 0.3 * matches.length;

        // Map pattern to fact type
        if (patternName === 'phone') suggestedTypes.add('phone');
        if (patternName === 'email') suggestedTypes.add('email');
        if (patternName === 'telegram') suggestedTypes.add('telegram');
        if (patternName === 'time' || patternName === 'date') {
          suggestedTypes.add('meeting');
          suggestedTypes.add('deadline');
        }
      }
    }

    // Check keywords
    for (const [category, keywords] of Object.entries(this.KEYWORDS)) {
      for (const keyword of keywords) {
        if (lowerContent.includes(keyword.toLowerCase())) {
          matchedPatterns.push(`keyword:${category}`);
          score += 0.15;
          suggestedTypes.add(category);
          break; // Only count category once
        }
      }
    }

    // Bonus for longer messages (more context)
    if (content.length > 100) score += 0.1;
    if (content.length > 300) score += 0.1;

    // Normalize score to 0-1 range
    score = Math.min(1, score);

    const isRelevant = score >= this.RELEVANCE_THRESHOLD;

    if (isRelevant) {
      this.logger.debug(
        `Relevant message (score=${score.toFixed(2)}): ${matchedPatterns.join(', ')}`,
      );
    }

    return {
      isRelevant,
      score,
      suggestedTypes: Array.from(suggestedTypes),
      matchedPatterns,
    };
  }

  /**
   * Filter a batch of messages, returning only relevant ones
   */
  filterBatch(
    messages: Array<{ id: string; content: string }>,
  ): Array<{ id: string; content: string; relevance: RelevanceResult }> {
    return messages
      .map((msg) => ({
        ...msg,
        relevance: this.checkRelevance(msg.content),
      }))
      .filter((msg) => msg.relevance.isRelevant);
  }

  /**
   * Get extraction type hints from relevance analysis
   * Helps LLM focus on specific fact types
   */
  getTypeHints(relevanceResults: RelevanceResult[]): string[] {
    const allTypes = new Set<string>();
    for (const result of relevanceResults) {
      for (const type of result.suggestedTypes) {
        allTypes.add(type);
      }
    }
    return Array.from(allTypes);
  }
}
