import { RelevanceFilterService, RelevanceResult } from './relevance-filter.service';

/** Helper to check if matchedPatterns contains a pattern type */
const hasPattern = (patterns: string[], type: string): boolean =>
  patterns.some((p) => p.startsWith(`${type}:`));

describe('RelevanceFilterService', () => {
  let service: RelevanceFilterService;

  beforeEach(() => {
    service = new RelevanceFilterService();
  });

  describe('checkRelevance', () => {
    describe('phone patterns', () => {
      it('should detect Russian phone number with +7', () => {
        const result = service.checkRelevance('Мой номер +7 999 123 45 67');
        expect(result.isRelevant).toBe(true);
        expect(result.suggestedTypes).toContain('phone');
        expect(hasPattern(result.matchedPatterns, 'phone')).toBe(true);
      });

      it('should detect phone number with 8', () => {
        const result = service.checkRelevance('Звони мне 8-999-123-45-67 пожалуйста');
        expect(result.isRelevant).toBe(true);
        expect(result.suggestedTypes).toContain('phone');
      });

      it('should detect phone number in parentheses format', () => {
        const result = service.checkRelevance('Телефон для связи: (999) 123-45-67');
        expect(result.isRelevant).toBe(true);
        expect(result.suggestedTypes).toContain('phone');
      });

      it('should not detect short number sequences', () => {
        const result = service.checkRelevance('Код подтверждения: 123456');
        expect(hasPattern(result.matchedPatterns, 'phone')).toBe(false);
      });
    });

    describe('email patterns', () => {
      it('should detect email address', () => {
        const result = service.checkRelevance('Пиши на email: test@example.com');
        expect(result.isRelevant).toBe(true);
        expect(result.suggestedTypes).toContain('email');
        expect(hasPattern(result.matchedPatterns, 'email')).toBe(true);
      });

      it('should detect email with subdomain', () => {
        const result = service.checkRelevance('Напиши мне на user@mail.company.ru');
        expect(result.isRelevant).toBe(true);
        expect(result.suggestedTypes).toContain('email');
      });

      it('should detect email with dots and dashes', () => {
        const result = service.checkRelevance('Мой адрес: test.user-name@company.co.uk');
        expect(result.isRelevant).toBe(true);
        expect(result.suggestedTypes).toContain('email');
      });
    });

    describe('telegram username patterns', () => {
      it('should detect telegram username', () => {
        const result = service.checkRelevance('Мой телеграм @username123, пиши туда');
        expect(result.isRelevant).toBe(true);
        expect(result.suggestedTypes).toContain('telegram');
        expect(hasPattern(result.matchedPatterns, 'telegram')).toBe(true);
      });

      it('should detect username with underscores', () => {
        const result = service.checkRelevance('Пиши мне в телеграм @user_name_test');
        expect(result.isRelevant).toBe(true);
        expect(result.suggestedTypes).toContain('telegram');
      });

      it('should not detect very short usernames', () => {
        const result = service.checkRelevance('Привет @abc как дела');
        expect(hasPattern(result.matchedPatterns, 'telegram')).toBe(false);
      });
    });

    describe('time patterns', () => {
      it('should detect time with colon', () => {
        const result = service.checkRelevance('Давай встретимся завтра в 15:30 в офисе');
        expect(result.isRelevant).toBe(true);
        expect(hasPattern(result.matchedPatterns, 'time')).toBe(true);
      });

      it('should detect time with dot', () => {
        const result = service.checkRelevance('Встретимся завтра в 10.00 на работе');
        expect(result.isRelevant).toBe(true);
        expect(hasPattern(result.matchedPatterns, 'time')).toBe(true);
      });

      it('should detect meeting keywords with time', () => {
        // Single keyword (0.15) isn't enough, add time pattern (0.30)
        const result = service.checkRelevance('Давай созвонимся завтра в 15:00 в офисе');
        expect(result.isRelevant).toBe(true);
        expect(result.suggestedTypes).toContain('meeting');
      });
    });

    describe('date patterns', () => {
      it('should detect date with dots', () => {
        const result = service.checkRelevance('Дедлайн проекта 25.12.2025 обязательно');
        expect(result.isRelevant).toBe(true);
        expect(hasPattern(result.matchedPatterns, 'date')).toBe(true);
      });

      it('should detect date with slashes', () => {
        const result = service.checkRelevance('Due by 25/12/2025 for the project');
        expect(result.isRelevant).toBe(true);
        expect(hasPattern(result.matchedPatterns, 'date')).toBe(true);
      });

      it('should detect date with dashes', () => {
        const result = service.checkRelevance('Планируем запуск на 2025-01-15');
        expect(result.isRelevant).toBe(true);
        expect(hasPattern(result.matchedPatterns, 'date')).toBe(true);
      });
    });

    describe('keyword detection', () => {
      describe('position keywords', () => {
        it('should detect work position mentions', () => {
          // "работаю" (0.15) + "компании" (0.15) + telegram pattern (0.30) = 0.60
          const result = service.checkRelevance('Я работаю программистом в IT компании, пиши мне @myusername');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('position');
        });

        it('should detect job title mentions', () => {
          // "директор" (0.15) + date pattern (0.30) = 0.45
          const result = service.checkRelevance('Меня назначили директором с 01.01.2025 года');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('position');
        });
      });

      describe('company keywords', () => {
        it('should detect company mentions', () => {
          // "компанию" (0.15) + "работаю" for position (0.15) = 0.30
          const result = service.checkRelevance('Перешёл в новую компанию, работаю там уже неделю');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('company');
        });

        it('should detect organization mentions', () => {
          // "организации" (0.15) + "работаю" for position (0.15) = 0.30
          const result = service.checkRelevance('Работаю в этой организации уже 5 лет');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('company');
        });
      });

      describe('meeting keywords', () => {
        it('should detect meeting mentions', () => {
          // "созвонимся" (0.15) + time pattern 15:00 (0.30) = 0.45
          const result = service.checkRelevance('Давай созвонимся завтра в 15:00 обсудить проект');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('meeting');
        });

        it('should detect appointment mentions', () => {
          // "встречу" (0.15) + date pattern (0.30) = 0.45
          const result = service.checkRelevance('Запланируем встречу на 15.01.2025 на неделю');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('meeting');
        });
      });

      describe('deadline keywords', () => {
        it('should detect deadline mentions', () => {
          // "дедлайн" (0.15) + date pattern (0.30) = 0.45
          const result = service.checkRelevance('Дедлайн проекта 25.12.2025 обязательно к выполнению');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('deadline');
        });

        it('should detect срок mentions', () => {
          // "срок" (0.15) + date pattern (0.30) = 0.45
          const result = service.checkRelevance('Срок сдачи до 15.01.2025, до конца месяца');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('deadline');
        });
      });

      describe('commitment keywords', () => {
        it('should detect commitment mentions', () => {
          // "договорились" (0.15) + time pattern (0.30) = 0.45
          const result = service.checkRelevance('Договорились о встрече в 15:00 на проекте');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('commitment');
        });

        it('should detect promise mentions', () => {
          // "обещал" (0.15) + time pattern (0.30) = 0.45
          const result = service.checkRelevance('Я обещал прислать документы, созвонимся в 15:00');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('commitment');
        });
      });

      describe('birthday keywords', () => {
        it('should detect birthday mentions', () => {
          // "день рождения" (0.15) + date pattern (0.30) = 0.45
          const result = service.checkRelevance('У меня день рождения 15.03.1990, каждый год отмечаем');
          expect(result.isRelevant).toBe(true);
          expect(result.suggestedTypes).toContain('personal');
        });
      });
    });

    describe('scoring', () => {
      it('should return higher score for multiple matches', () => {
        const singleMatch = service.checkRelevance('Мой номер +7 999 123 45 67');
        const multipleMatches = service.checkRelevance(
          'Мой номер +7 999 123 45 67, email test@example.com'
        );

        expect(multipleMatches.score).toBeGreaterThan(singleMatch.score);
      });

      it('should return score between 0 and 1', () => {
        const result = service.checkRelevance(
          'Привет! Меня зовут Иван, работаю в компании, email: test@test.com, телефон +7999123456'
        );

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      });

      it('should cap score at 1.0', () => {
        const result = service.checkRelevance(
          `Работаю директором в компании, созвонимся в 15:00, дедлайн 25.12.2025,
          договорились встретиться, email test@test.com, телефон +79991234567,
          мой телеграм @username, день рождения скоро`
        );

        expect(result.score).toBe(1);
      });
    });

    describe('irrelevant messages', () => {
      it('should return not relevant for short messages', () => {
        const result = service.checkRelevance('Привет');
        expect(result.isRelevant).toBe(false);
        expect(result.score).toBe(0);
      });

      it('should return not relevant for empty messages', () => {
        const result = service.checkRelevance('');
        expect(result.isRelevant).toBe(false);
      });

      it('should return not relevant for generic chat without patterns', () => {
        const result = service.checkRelevance('Как дела? Что нового? Отлично выглядишь!');
        expect(result.isRelevant).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle messages with only whitespace', () => {
        const result = service.checkRelevance('   \n\t   ');
        expect(result.isRelevant).toBe(false);
      });

      it('should handle unicode content', () => {
        const result = service.checkRelevance('Моя почта: тест@пример.рф для связи');
        // May or may not match depending on regex - just ensure no crash
        expect(typeof result.isRelevant).toBe('boolean');
      });

      it('should handle very long messages', () => {
        const longMessage = 'Это тестовое сообщение '.repeat(1000);
        const result = service.checkRelevance(longMessage);
        // Should not throw and should complete
        expect(typeof result.isRelevant).toBe('boolean');
      });
    });
  });

  describe('filterBatch', () => {
    it('should filter array of messages', () => {
      const messages = [
        { id: '1', content: 'Привет' },
        { id: '2', content: 'Мой email для связи: test@test.com' },
        { id: '3', content: 'Как дела?' },
        { id: '4', content: 'Позвони мне по номеру +7 999 123 45 67' },
      ];

      const result = service.filterBatch(messages);

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id)).toContain('2');
      expect(result.map((r) => r.id)).toContain('4');
    });

    it('should return empty array for no relevant messages', () => {
      const messages = [
        { id: '1', content: 'Привет' },
        { id: '2', content: 'Как дела?' },
        { id: '3', content: 'Ок' },
      ];

      const result = service.filterBatch(messages);

      expect(result).toHaveLength(0);
    });

    it('should include relevance data in results', () => {
      const messages = [
        { id: '1', content: 'Email для связи: test@test.com' },
        { id: '2', content: 'Email: test@test.com, телефон +79991234567, работаю директором' },
      ];

      const result = service.filterBatch(messages);

      expect(result).toHaveLength(2);
      expect(result[0].relevance).toBeDefined();
      expect(result[0].relevance.isRelevant).toBe(true);
      // Second message should have higher score due to more matches
      expect(result[1].relevance.score).toBeGreaterThan(result[0].relevance.score);
    });
  });
});
