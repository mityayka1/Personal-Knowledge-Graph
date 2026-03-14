/**
 * Shared quality-filter constants for the extraction pipeline.
 *
 * Used by:
 * - DailySynthesisExtractionService (filterLowQuality*)
 * - ExtractionToolsProvider (create_event tool)
 * - DraftExtractionService (task/commitment quality gate)
 */

/** Vague pronouns / placeholders that indicate non-specific content.
 *  Note: \b doesn't work with Cyrillic in JS — using (?<!\p{L}) / (?!\p{L}) instead. */
export const VAGUE_PATTERNS: RegExp[] = [
  /(?<!\p{L})что[-\s]?то(?!\p{L})/iu,
  /(?<!\p{L})кое[-\s]?что(?!\p{L})/iu,
  /(?<!\p{L})кое[-\s]?как(?!\p{L})/iu,
  /(?<!\p{L})как[-\s]?нибудь(?!\p{L})/iu,
  /(?<!\p{L})как[-\s]?то(?!\p{L})/iu,
  /(?<!\p{L})где[-\s]?то(?!\p{L})/iu,
  /(?<!\p{L})когда[-\s]?нибудь(?!\p{L})/iu,
  /(?<!\p{L})что[-\s]?нибудь(?!\p{L})/iu,
  /(?<!\p{L})куда[-\s]?то(?!\p{L})/iu,
  /(?<!\p{L})че[-\s]?нибудь(?!\p{L})/iu,
  /(?<!\p{L})че[-\s]?нить(?!\p{L})/iu,
];

/** Noise patterns — technical / meta content that doesn't carry real-world information. */
export const NOISE_PATTERNS: RegExp[] = [
  /подтвержд\w*\s+(использовани|инструмент)/iu,
  /использовани\w*\s+инструмент/iu,
  /тестов\w*\s+(запуск|прогон|сообщени)/iu,
  /отправ\w*\s+тестов/iu,
];

/** Minimum meaningful content length for event descriptions. */
export const MIN_MEANINGFUL_LENGTH = 15;

/** Returns true if text is dominated by vague placeholders. */
export function isVagueContent(text: string): boolean {
  return VAGUE_PATTERNS.some((p) => p.test(text));
}

/** Returns true if text matches known noise patterns (technical / meta content). */
export function isNoiseContent(text: string): boolean {
  if (text.length < MIN_MEANINGFUL_LENGTH) return true;
  return NOISE_PATTERNS.some((p) => p.test(text));
}

/**
 * Per-type minimum confidence thresholds.
 * Confidence = actionability: how likely this item can be acted upon.
 *
 * Tasks/commitments require higher confidence because false positives
 * create noise in morning briefs and TODO lists.
 * Facts are cheaper — wrong fact can be superseded later.
 */
export const MIN_CONFIDENCE: Record<string, number> = {
  task: 0.7,
  promise_by_me: 0.75,
  promise_by_them: 0.75,
  meeting: 0.7,
  fact: 0.65,
};

/** Get minimum confidence for an event type. Returns 0.7 for unknown types. */
export function getMinConfidence(eventType: string): number {
  return MIN_CONFIDENCE[eventType] ?? 0.7;
}

/**
 * Patterns indicating informational statements, NOT actionable commitments.
 * These describe past completed actions or status updates that should NOT
 * be extracted as promise_by_me/promise_by_them.
 *
 * Examples rejected in PA audit:
 * - "Обсудили детали проекта" (past discussion, not a promise)
 * - "Согласовал стоимость" (completed action, not a commitment)
 * - "Подтвердил получение" (acknowledgment, not a promise)
 */
export const INFORMATIONAL_COMMITMENT_PATTERNS: RegExp[] = [
  // Past-tense completions: stems that need -л/-ла/-ли/-ло suffix to be past tense.
  // Without the suffix these stems match infinitives (обсудить, отправить) — must NOT match those.
  /(?<!\p{L})(обсуди|согласова|подтверди|отправи|переда|уточни|рассмотре|проанализирова|обнови|настрои|подготови)(л[аоие]?с[ья]|л[аоие]?)(?!\p{L})/iu,
  // Already past-tense forms (stem already ends in -л): завершил, проверил, сделал, etc.
  /(?<!\p{L})(завершил|закрыл|решил|исправил|доделал|переделал|сделал|проверил|загрузил|выполнил|установил|подключил|разобрал)(а|и|ся|ась|ись|ось)?(?!\p{L})/iu,
  // Information sharing: stems + past-tense suffix
  /(?<!\p{L})(сообщи|рассказа|написа|показа|поясни|объясни|указа|описа|продемонстрирова)(л[аоие]?с[ья]|л[аоие]?)(?!\p{L})/iu,
  // Acknowledgments (already past-tense forms)
  /(?<!\p{L})(понял|принял|учёл|учел|заметил|увидел|узнал|получил)(а|и)?(?!\p{L})/iu,
];

/**
 * Returns true if commitment text is informational (not actionable).
 * Checks that the text doesn't also contain future-oriented markers.
 */
export function isInformationalCommitment(text: string): boolean {
  const hasInformational = INFORMATIONAL_COMMITMENT_PATTERNS.some((p) =>
    p.test(text),
  );
  if (!hasInformational) return false;

  // Exception: if text also has future markers, it might be actionable
  const futureMarkers =
    /(?<!\p{L})(нужно|надо|необходимо|планиру|собираюсь|буд[ую]|обещаю|должен|готов\s|завтра|на следующей|до конца|к пятниц|к понедельник)/iu;
  return !futureMarkers.test(text);
}

/**
 * Patterns indicating ephemeral (short-lived) fact values.
 * These should be auto-superseded or filtered out.
 * Covers: current mood, temporary state, location "right now", one-time preferences.
 */
const EPHEMERAL_VALUE_PATTERNS: RegExp[] = [
  // Temporary states: болеет, устал, в отпуске, на больничном, в командировке
  /(?<!\p{L})(болеет|устал|заболел|простудился|в отпуск|на больничном|в командировк|на совещании|на встрече|в дороге|в пробке)\p{L}*/iu,
  // Mood/feeling: настроение, чувствует себя, выглядит
  /(?<!\p{L})(настроени|чувствует\s+себя|выглядит|жалуется|нервничает|переживает|радуется|расстроен)\p{L}*/iu,
  // "Сейчас" / "сегодня" location: сейчас в Москве, сегодня работает из дома
  /(?<!\p{L})(сейчас|сегодня|в данный момент|прямо сейчас|на этой неделе)\s/iu,
];

/**
 * Returns true if fact value is ephemeral (temporary state).
 * Only applies to fact types that CAN be ephemeral: status, health, location.
 */
export function isEphemeralFactValue(factType: string, value: string): boolean {
  // Status and health are always ephemeral (handled by EPHEMERAL_FACT_TYPES in fusion)
  if (factType === 'status' || factType === 'health') return true;
  // For location/preference — check patterns
  if (factType === 'location' || factType === 'preference') {
    return EPHEMERAL_VALUE_PATTERNS.some((p) => p.test(value));
  }
  return false;
}

/**
 * Patterns indicating project/business data mistakenly extracted as personal facts.
 * Examples from PA audit:
 * - "стоимость работ 424 000" → project cost, not person attribute
 * - "API endpoint /api/v1/users" → technical config
 * - "бюджет проекта 2M" → project budget
 */
const PROJECT_DATA_PATTERNS: RegExp[] = [
  // Financial: стоимость, бюджет, цена, тариф, счёт + numbers
  /(?<!\p{L})(стоимость|бюджет|цена|тариф|счёт|оплата|invoice|прайс)\p{L}*\s.*\d/iu,
  // Technical: API, endpoint, URL, IP, конфигурация, сервер, порт
  /(?<!\p{L})(api|endpoint|url|ip[-\s]?адрес|конфигурац|сервер|порт|домен|хостинг|деплой|docker|nginx)\p{L}*/iu,
  // Amounts with currency: 424 000₽, $5000, 2M руб
  /\d[\d\s.,]*\s*[₽$€руб]/iu,
  // Percentages with business context: маржа 15%, скидка 10%
  /(марж|скидк|наценк|комисси)\p{L}*\s*\d+\s*%/iu,
];

/**
 * Returns true if fact looks like project/business data rather than a personal attribute.
 * Applies to: specialization, communication, preference, status fact types.
 */
export function isProjectDataFact(factType: string, value: string): boolean {
  // These fact types are inherently personal — never filter
  const personalTypes = new Set([
    'birthday',
    'family',
    'hobby',
    'education',
    'language',
    'health',
    'position',
    'specialization',
  ]);
  if (personalTypes.has(factType)) return false;

  return PROJECT_DATA_PATTERNS.some((p) => p.test(value));
}

/**
 * Past-tense verb patterns indicating completed actions, not future tasks.
 *
 * Russian past tense: verb stem + л/ла/ли/ло (обсудили, отправил, настроила)
 * These at START of task title indicate a report, not a TODO.
 */
const PAST_TENSE_TASK_PATTERNS: RegExp[] = [
  // Starts with past-tense verb — stem + л/ла/ли/ло/лся/лась/лись/лось
  // Two groups: stems ending before "л" (need explicit л) and stems already ending in "л"
  /^\s*(обсуди|отправи|настрои|подготови|написа|обнови|проанализирова|согласова|переда|оптимизирова)(л[аоие]?с[ья]|л[аоие]?)(?!\p{L})/iu,
  /^\s*(завершил|проверил|создал|удалил|исправил|подключил|загрузил|протестировал|сделал|разобрал|выполнил|закрыл|перенёс|установил|доработал|переработал|реализовал)(а|и|ся|ась|ись|ось)?(?!\p{L})/iu,
  // Also catch "был + participle" constructions
  /^\s*был[аоие]?\s+(завершен|выполнен|отправлен|настроен|создан|удалён|обновлён)/iu,
];

/**
 * Returns true if task title describes a past (completed) action.
 * Does NOT filter if future markers are present ("обсудили и решили что нужно...").
 */
export function isPastTenseTask(title: string): boolean {
  const isPast = PAST_TENSE_TASK_PATTERNS.some((p) => p.test(title));
  if (!isPast) return false;

  // Exception: future continuation markers
  const futureContinuation =
    /(?<!\p{L})(нужно|надо|необходимо|требуется|осталось|ещё|еще\s+нужно|далее|потом|затем|следующ)/iu;
  return !futureContinuation.test(title);
}
