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
  task: 0.75,
  promise_by_me: 0.8,
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
  // Past-tense completions: обсудили, согласовали, подтвердил, отправил, передал, уточнил
  // Note: \w doesn't match Cyrillic in JS — using \p{L} instead.
  /(?<!\p{L})(обсуди|согласова|подтверди|отправи|переда|уточни|рассмотре|проанализирова|обнови|настрои|подготови|завершил|закрыл|решил|исправил|доделал|переделал|сделал|проверил|загрузил|выполнил|установил|подключил|разобрал|разобрался)\p{L}*(?!\p{L})/iu,
  // Information sharing: сообщил, рассказал, написал, показал, пояснил
  /(?<!\p{L})(сообщи|рассказа|написа|показа|поясни|объясни|указа|описа|продемонстрирова)\p{L}*(?!\p{L})/iu,
  // Acknowledgments: понял, принял, учёл, заметил, увидел
  /(?<!\p{L})(понял|принял|учёл|учел|заметил|увидел|узнал|получил)\p{L}*(?!\p{L})/iu,
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
