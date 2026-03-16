import {
  isVagueContent,
  isNoiseContent,
  getMinConfidence,
  isInformationalCommitment,
  isEphemeralFactValue,
  isProjectDataFact,
  isPastTenseTask,
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
    it('should return 0.7 for task', () => {
      expect(getMinConfidence('task')).toBe(0.7);
    });

    it('should return 0.75 for promise_by_me', () => {
      expect(getMinConfidence('promise_by_me')).toBe(0.75);
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
      expect(isInformationalCommitment('Создал инструкцию по подключению')).toBe(true);
      expect(isInformationalCommitment('Удалил старые записи')).toBe(true);
      expect(isInformationalCommitment('Реализовал новую фичу')).toBe(true);
      // Added verbs (production audit gap)
      expect(isInformationalCommitment('Добавил артикулы в отчёт')).toBe(true);
      expect(isInformationalCommitment('Поменял колонки местами')).toBe(true);
      expect(isInformationalCommitment('Изменил структуру таблицы')).toBe(true);
      expect(isInformationalCommitment('Заменил старый компонент')).toBe(true);
      expect(isInformationalCommitment('Переместил файлы в архив')).toBe(true);
      expect(isInformationalCommitment('Опубликовал статью')).toBe(true);
      expect(isInformationalCommitment('Обработал заявки клиентов')).toBe(true);
    });

    it('rejects passive past participles', () => {
      expect(isInformationalCommitment('Создан ЗЦТО по новому проекту')).toBe(true);
      expect(isInformationalCommitment('Внесены изменения в конфигурацию')).toBe(true);
      expect(isInformationalCommitment('Внесён правки в документ')).toBe(true);
      expect(isInformationalCommitment('Выполнен деплой на продакшн')).toBe(true);
      expect(isInformationalCommitment('Отправлен отчёт клиенту')).toBe(true);
      expect(isInformationalCommitment('Обновлена документация')).toBe(true);
      expect(isInformationalCommitment('Настроена интеграция с API')).toBe(true);
      // Added participles (production audit gap)
      expect(isInformationalCommitment('Добавлены артикулы в демо-отчет')).toBe(true);
      expect(isInformationalCommitment('Изменена структура отчёта')).toBe(true);
      expect(isInformationalCommitment('Заменён старый модуль')).toBe(true);
      expect(isInformationalCommitment('Перемещены файлы в архив')).toBe(true);
      expect(isInformationalCommitment('Опубликован релиз')).toBe(true);
      expect(isInformationalCommitment('Подготовлен план проекта')).toBe(true);
      expect(isInformationalCommitment('Согласована стоимость работ')).toBe(true);
      expect(isInformationalCommitment('Передан отчёт заказчику')).toBe(true);
      expect(isInformationalCommitment('Проверено качество данных')).toBe(true);
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

    it('does NOT flag infinitive forms (critical: shared stems)', () => {
      expect(isInformationalCommitment('Обсудить создание нового модуля')).toBe(false);
      expect(isInformationalCommitment('Отправить документацию клиенту')).toBe(false);
      expect(isInformationalCommitment('Настроить CI/CD pipeline')).toBe(false);
      expect(isInformationalCommitment('Подготовить отчёт к пятнице')).toBe(false);
      expect(isInformationalCommitment('Уточнить детали по проекту')).toBe(false);
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

  describe('isEphemeralFactValue', () => {
    it('detects health/status as always ephemeral', () => {
      expect(isEphemeralFactValue('status', 'работает над отчётом')).toBe(true);
      expect(isEphemeralFactValue('health', 'болеет')).toBe(true);
    });

    it('detects temporary location', () => {
      expect(isEphemeralFactValue('location', 'сейчас в Москве')).toBe(true);
      expect(isEphemeralFactValue('location', 'сегодня работает из дома')).toBe(true);
    });

    it('preserves permanent location', () => {
      expect(isEphemeralFactValue('location', 'живёт в Краснодаре')).toBe(false);
      expect(isEphemeralFactValue('location', 'офис в Москве')).toBe(false);
    });

    it('detects temporary preference', () => {
      expect(isEphemeralFactValue('preference', 'сегодня предпочитает онлайн')).toBe(true);
    });

    it('preserves non-ephemeral fact types', () => {
      expect(isEphemeralFactValue('position', 'CTO в Сбербанке')).toBe(false);
      expect(isEphemeralFactValue('birthday', '15 марта')).toBe(false);
    });
  });

  describe('isProjectDataFact', () => {
    it('detects financial data in non-personal fact types', () => {
      expect(isProjectDataFact('communication', 'бюджет проекта 2M руб')).toBe(true);
      expect(isProjectDataFact('status', 'стоимость работ 424 000₽')).toBe(true);
    });

    it('detects technical config in non-personal fact types', () => {
      expect(isProjectDataFact('status', 'сервер на порту 3000')).toBe(true);
      expect(isProjectDataFact('communication', 'деплой на docker')).toBe(true);
    });

    it('detects currency amounts', () => {
      expect(isProjectDataFact('communication', 'цена 50 000₽')).toBe(true);
      expect(isProjectDataFact('preference', 'оплата $5000')).toBe(true);
    });

    it('preserves personal facts', () => {
      expect(isProjectDataFact('birthday', '15 марта')).toBe(false);
      expect(isProjectDataFact('hobby', 'занимается бегом')).toBe(false);
      expect(isProjectDataFact('education', 'МГУ, физфак')).toBe(false);
      expect(isProjectDataFact('family', 'женат, двое детей')).toBe(false);
    });

    it('preserves position/specialization (always personal)', () => {
      expect(isProjectDataFact('position', 'CTO в Сбербанке')).toBe(false);
      expect(isProjectDataFact('specialization', 'frontend разработчик')).toBe(false);
      // Even with tech terms — these fact types are inherently personal
      expect(isProjectDataFact('specialization', 'настроил API endpoint')).toBe(false);
      expect(isProjectDataFact('position', 'DevOps engineer, docker specialist')).toBe(false);
    });
  });

  describe('isPastTenseTask', () => {
    it('rejects past-tense tasks', () => {
      expect(isPastTenseTask('Обсудили план проекта')).toBe(true);
      expect(isPastTenseTask('Отправил документы клиенту')).toBe(true);
      expect(isPastTenseTask('Настроил CI/CD pipeline')).toBe(true);
      expect(isPastTenseTask('Завершил интеграцию с API')).toBe(true);
      expect(isPastTenseTask('Проверил код и отправил на ревью')).toBe(true);
      // Added verbs (production audit gap)
      expect(isPastTenseTask('Добавил артикулы в отчёт')).toBe(true);
      expect(isPastTenseTask('Поменял порядок колонок')).toBe(true);
      expect(isPastTenseTask('Изменил конфигурацию сервера')).toBe(true);
      expect(isPastTenseTask('Заменила старый модуль')).toBe(true);
      expect(isPastTenseTask('Опубликовал новую версию')).toBe(true);
      expect(isPastTenseTask('Обработал входящие заявки')).toBe(true);
    });

    it('rejects "был + participle" form', () => {
      expect(isPastTenseTask('Был завершен деплой')).toBe(true);
      expect(isPastTenseTask('Была выполнена миграция')).toBe(true);
      // Added participles
      expect(isPastTenseTask('Был добавлен новый модуль')).toBe(true);
      expect(isPastTenseTask('Был подготовлен отчёт')).toBe(true);
    });

    it('rejects standalone passive participles at start', () => {
      expect(isPastTenseTask('Добавлены артикулы в демо-отчет')).toBe(true);
      expect(isPastTenseTask('Создан отчёт по проекту')).toBe(true);
      expect(isPastTenseTask('Изменена структура таблицы')).toBe(true);
      expect(isPastTenseTask('Опубликован релиз v2.0')).toBe(true);
      expect(isPastTenseTask('Подготовлено ТЗ для разработки')).toBe(true);
      expect(isPastTenseTask('Согласованы условия контракта')).toBe(true);
      expect(isPastTenseTask('Проверены данные за март')).toBe(true);
    });

    it('allows future tasks (infinitive form)', () => {
      expect(isPastTenseTask('Настроить CI/CD pipeline')).toBe(false);
      expect(isPastTenseTask('Подготовить отчёт к пятнице')).toBe(false);
      expect(isPastTenseTask('Нужно обновить зависимости')).toBe(false);
    });

    it('allows past-tense with future continuation', () => {
      expect(isPastTenseTask('Обсудили, нужно ещё доработать')).toBe(false);
      expect(isPastTenseTask('Проверил, осталось исправить тесты')).toBe(false);
      expect(isPastTenseTask('Настроил, но далее необходимо протестировать')).toBe(false);
    });

    it('allows text not starting with past-tense verb', () => {
      expect(isPastTenseTask('Встреча с клиентом в 15:00')).toBe(false);
      expect(isPastTenseTask('CI/CD настроен некорректно')).toBe(false);
    });
  });
});
