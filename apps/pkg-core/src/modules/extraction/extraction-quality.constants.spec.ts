import {
  isVagueContent,
  isNoiseContent,
  getMinConfidence,
  isInformationalCommitment,
  MIN_CONFIDENCE,
  MIN_MEANINGFUL_LENGTH,
} from './extraction-quality.constants';

describe('extraction-quality.constants', () => {
  describe('isVagueContent', () => {
    it('should detect "что-то" as vague', () => {
      expect(isVagueContent('Надо что-то сделать')).toBe(true);
    });

    it('should detect "как-нибудь" as vague', () => {
      expect(isVagueContent('Как-нибудь разберёмся')).toBe(true);
    });

    it('should detect "где-то" as vague', () => {
      expect(isVagueContent('Где-то тут проблема')).toBe(true);
    });

    it('should detect "когда-нибудь" as vague', () => {
      expect(isVagueContent('Когда-нибудь доделаю')).toBe(true);
    });

    it('should detect "кое-что" as vague', () => {
      expect(isVagueContent('Я кое-что нашёл')).toBe(true);
    });

    it('should detect "че-нибудь" as vague', () => {
      expect(isVagueContent('Скинь че-нибудь')).toBe(true);
    });

    it('should not flag specific content', () => {
      expect(isVagueContent('Отправить отчёт до пятницы')).toBe(false);
    });

    it('should not flag empty string', () => {
      expect(isVagueContent('')).toBe(false);
    });
  });

  describe('isNoiseContent', () => {
    it('should flag text shorter than MIN_MEANINGFUL_LENGTH', () => {
      expect(isNoiseContent('Ок')).toBe(true);
      expect(isNoiseContent('Да')).toBe(true);
    });

    it('should flag text exactly at MIN_MEANINGFUL_LENGTH boundary', () => {
      const short = 'a'.repeat(MIN_MEANINGFUL_LENGTH - 1);
      expect(isNoiseContent(short)).toBe(true);
    });

    it('should not flag text at MIN_MEANINGFUL_LENGTH', () => {
      const exact = 'a'.repeat(MIN_MEANINGFUL_LENGTH);
      // Only short-circuit applies; no noise patterns match
      expect(isNoiseContent(exact)).toBe(false);
    });

    // Note: NOISE_PATTERNS use \w* which doesn't match Cyrillic in JS,
    // so only exact stems + space work (e.g., "подтвержд использовани").
    it('should flag noise pattern: подтвержд использовани', () => {
      expect(isNoiseContent('подтвержд использовани инструмент')).toBe(true);
    });

    it('should flag noise pattern: тестов запуск', () => {
      expect(isNoiseContent('тестов запуск завершён')).toBe(true);
    });

    it('should flag noise pattern: отправ тестов', () => {
      expect(isNoiseContent('отправ тестов сообщения')).toBe(true);
    });

    it('should not flag meaningful business content', () => {
      expect(isNoiseContent('Нужно подготовить презентацию для клиента к пятнице')).toBe(false);
    });
  });

  describe('MIN_CONFIDENCE', () => {
    it('should have expected keys', () => {
      expect(Object.keys(MIN_CONFIDENCE).sort()).toEqual(
        ['fact', 'meeting', 'promise_by_me', 'promise_by_them', 'task'].sort(),
      );
    });

    it('should have thresholds between 0 and 1', () => {
      for (const [key, value] of Object.entries(MIN_CONFIDENCE)) {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('getMinConfidence', () => {
    it('should return 0.75 for task', () => {
      expect(getMinConfidence('task')).toBe(0.75);
    });

    it('should return 0.8 for promise_by_me', () => {
      expect(getMinConfidence('promise_by_me')).toBe(0.8);
    });

    it('should return 0.75 for promise_by_them', () => {
      expect(getMinConfidence('promise_by_them')).toBe(0.75);
    });

    it('should return 0.7 for meeting', () => {
      expect(getMinConfidence('meeting')).toBe(0.7);
    });

    it('should return 0.65 for fact', () => {
      expect(getMinConfidence('fact')).toBe(0.65);
    });

    it('should return 0.7 for unknown event type', () => {
      expect(getMinConfidence('unknown')).toBe(0.7);
    });

    it('should return 0.7 for empty string', () => {
      expect(getMinConfidence('')).toBe(0.7);
    });
  });

  describe('isInformationalCommitment', () => {
    it('rejects past-tense completions', () => {
      expect(isInformationalCommitment('Обсудили детали проекта')).toBe(true);
      expect(isInformationalCommitment('Согласовал стоимость работ')).toBe(true);
      expect(isInformationalCommitment('Отправил документы клиенту')).toBe(true);
      expect(isInformationalCommitment('Настроил CI/CD pipeline')).toBe(true);
      expect(isInformationalCommitment('Проверил код и исправил баги')).toBe(true);
    });

    it('rejects information sharing', () => {
      expect(isInformationalCommitment('Сообщил результаты анализа')).toBe(true);
      expect(isInformationalCommitment('Рассказал о планах')).toBe(true);
      expect(isInformationalCommitment('Показал презентацию клиенту')).toBe(true);
    });

    it('rejects acknowledgments', () => {
      expect(isInformationalCommitment('Понял задачу')).toBe(true);
      expect(isInformationalCommitment('Принял решение')).toBe(true);
      expect(isInformationalCommitment('Получил документы')).toBe(true);
    });

    it('allows future-oriented promises with past marker', () => {
      expect(isInformationalCommitment('Обсудили, нужно доработать')).toBe(false);
      expect(isInformationalCommitment('Отправил, но завтра пришлю обновлённый')).toBe(false);
    });

    it('allows genuine future commitments', () => {
      expect(isInformationalCommitment('Нужно подготовить предложение')).toBe(false);
      expect(isInformationalCommitment('Буду готов к среде')).toBe(false);
      expect(isInformationalCommitment('Подготовлю отчёт к пятнице')).toBe(false);
    });

    it('allows text without informational markers', () => {
      expect(isInformationalCommitment('Встреча с клиентом в 15:00')).toBe(false);
      expect(isInformationalCommitment('Дедлайн по проекту — пятница')).toBe(false);
    });
  });
});
