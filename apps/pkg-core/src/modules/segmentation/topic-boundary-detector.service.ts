import { Injectable, Logger } from '@nestjs/common';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SegmentationService } from './segmentation.service';
import { SettingsService } from '../settings/settings.service';
import {
  DetectBoundariesParams,
  DetectBoundariesResult,
  DetectedSegment,
  SegmentationResponse,
  TOPIC_SEGMENTATION_SCHEMA,
} from './topic-boundary-detector.types';
import { MessageData } from '../extraction/extraction.types';

/** Minimum messages to attempt segmentation */
const MIN_MESSAGES_FOR_SEGMENTATION = 4;

/** Maximum messages per Claude call (to fit context window) */
const MAX_MESSAGES_PER_BATCH = 200;

/** Time gap in minutes that suggests a topic boundary */
const TIME_GAP_MINUTES = 60;

@Injectable()
export class TopicBoundaryDetectorService {
  private readonly logger = new Logger(TopicBoundaryDetectorService.name);

  constructor(
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly segmentationService: SegmentationService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Detect topic boundaries in a batch of messages and create TopicalSegments.
   *
   * Flow:
   * 1. Pre-filter: skip if too few messages
   * 2. Split into time-gap-based chunks for large conversations
   * 3. Send each chunk to Claude for semantic segmentation
   * 4. Create TopicalSegment records via SegmentationService
   * 5. Return stats
   */
  async detectAndCreate(params: DetectBoundariesParams): Promise<DetectBoundariesResult> {
    const startTime = Date.now();
    const { chatId, interactionId, messages, participantIds, primaryParticipantId, chatTitle, activityId } = params;

    // Pre-filter: need enough messages to segment
    if (messages.length < MIN_MESSAGES_FOR_SEGMENTATION) {
      this.logger.debug(
        `[segmentation] Skipping: only ${messages.length} messages (need ${MIN_MESSAGES_FOR_SEGMENTATION}+)`,
      );
      return {
        segmentIds: [],
        segmentCount: 0,
        messagesAssigned: 0,
        messagesSkipped: messages.length,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Split into manageable chunks by time gaps
    const chunks = this.splitByTimeGaps(messages);

    this.logger.log(
      `[segmentation] Processing ${messages.length} messages in ${chunks.length} chunk(s) ` +
        `for chat ${chatId}, interaction ${interactionId}`,
    );

    let totalTokens = 0;
    const allSegmentIds: string[] = [];
    let totalAssigned = 0;
    let totalSkipped = 0;

    for (const chunk of chunks) {
      if (chunk.messages.length < MIN_MESSAGES_FOR_SEGMENTATION) {
        totalSkipped += chunk.messages.length;
        continue;
      }

      // Call Claude for semantic segmentation
      const detected = await this.detectBoundaries(chunk.messages, chatTitle);
      totalTokens += detected.tokensUsed;

      // Create TopicalSegments
      for (const segment of detected.segments) {
        const segmentMessages = segment.messageIndices
          .filter((idx) => idx >= 0 && idx < chunk.messages.length)
          .map((idx) => chunk.messages[idx]);

        if (segmentMessages.length === 0) continue;

        const messageIds = segmentMessages.map((m) => m.id);
        const startedAt = segmentMessages[0].timestamp;
        const endedAt = segmentMessages[segmentMessages.length - 1].timestamp;

        try {
          const created = await this.segmentationService.createSegment({
            topic: segment.topic,
            keywords: segment.keywords,
            summary: segment.summary,
            chatId,
            interactionId,
            activityId: activityId ?? undefined,
            participantIds,
            primaryParticipantId: primaryParticipantId ?? undefined,
            messageIds,
            startedAt,
            endedAt,
            confidence: segment.confidence,
          });

          allSegmentIds.push(created.id);
          totalAssigned += messageIds.length;

          this.logger.debug(
            `[segmentation] Created segment "${segment.topic}" with ${messageIds.length} messages`,
          );
        } catch (error: any) {
          this.logger.warn(
            `[segmentation] Failed to create segment "${segment.topic}": ${error.message}`,
          );
        }
      }

      totalSkipped += detected.skippedCount;
    }

    const durationMs = Date.now() - startTime;

    this.logger.log(
      `[segmentation] Completed: ${allSegmentIds.length} segments, ` +
        `${totalAssigned} messages assigned, ${totalSkipped} skipped, ` +
        `${totalTokens} tokens, ${durationMs}ms`,
    );

    return {
      segmentIds: allSegmentIds,
      segmentCount: allSegmentIds.length,
      messagesAssigned: totalAssigned,
      messagesSkipped: totalSkipped,
      tokensUsed: totalTokens,
      durationMs,
    };
  }

  /**
   * Split messages into chunks by time gaps.
   * Large time gaps (> TIME_GAP_MINUTES) are natural conversation breaks.
   */
  private splitByTimeGaps(
    messages: MessageData[],
  ): Array<{ messages: MessageData[]; globalOffset: number }> {
    if (messages.length <= MAX_MESSAGES_PER_BATCH) {
      return [{ messages, globalOffset: 0 }];
    }

    const chunks: Array<{ messages: MessageData[]; globalOffset: number }> = [];
    let currentChunk: MessageData[] = [messages[0]];
    let chunkStartOffset = 0;

    for (let i = 1; i < messages.length; i++) {
      const prev = new Date(messages[i - 1].timestamp).getTime();
      const curr = new Date(messages[i].timestamp).getTime();
      const gapMinutes = (curr - prev) / (1000 * 60);

      if (gapMinutes >= TIME_GAP_MINUTES || currentChunk.length >= MAX_MESSAGES_PER_BATCH) {
        chunks.push({ messages: currentChunk, globalOffset: chunkStartOffset });
        currentChunk = [messages[i]];
        chunkStartOffset = i;
      } else {
        currentChunk.push(messages[i]);
      }
    }

    if (currentChunk.length > 0) {
      chunks.push({ messages: currentChunk, globalOffset: chunkStartOffset });
    }

    return chunks;
  }

  /**
   * Call Claude to detect topic boundaries in a batch of messages.
   */
  private async detectBoundaries(
    messages: MessageData[],
    chatTitle?: string,
  ): Promise<{ segments: DetectedSegment[]; skippedCount: number; tokensUsed: number }> {
    const prompt = this.buildPrompt(messages, chatTitle);

    const result = await this.claudeAgentService.call<SegmentationResponse>({
      mode: 'oneshot',
      taskType: 'topic_segmentation',
      prompt,
      model: 'haiku',
      schema: TOPIC_SEGMENTATION_SCHEMA,
      maxTurns: 3,
      timeout: 60000,
    });

    if (!result.data) {
      this.logger.warn('[segmentation] Claude returned empty response for topic segmentation');
      return { segments: [], skippedCount: messages.length, tokensUsed: 0 };
    }

    const segments = this.validateSegments(result.data.segments, messages.length);
    const skippedCount = result.data.skippedMessageIndices?.length ?? 0;
    const tokensUsed = result.usage.inputTokens + result.usage.outputTokens;

    return { segments, skippedCount, tokensUsed };
  }

  /**
   * Build the segmentation prompt.
   */
  private buildPrompt(messages: MessageData[], chatTitle?: string): string {
    const chatContext = chatTitle ? `\nЧАТ: "${chatTitle}"` : '';

    const formattedMessages = messages
      .map((m, i) => {
        const sender = m.isOutgoing ? 'Я' : (m.senderEntityName || 'Собеседник');
        const time = new Date(m.timestamp).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        });
        const content = m.content || '[медиа]';
        return `[${i}] ${time} ${sender}: ${content}`;
      })
      .join('\n');

    return `Ты — эксперт по сегментации диалогов. Твоя задача — разбить переписку на тематические сегменты.
${chatContext}

══════════════════════════════════════════
СООБЩЕНИЯ (${messages.length} шт.)
══════════════════════════════════════════
${formattedMessages}

══════════════════════════════════════════
ЗАДАНИЕ
══════════════════════════════════════════

Проанализируй переписку и разбей её на тематические сегменты:

1. **Определи границы тем** — где разговор переходит с одной темы на другую.
   Признаки смены темы:
   - Явная смена предмета обсуждения (topic_change)
   - Большой временной разрыв между сообщениями (time_gap)
   - Явный маркер: "кстати", "по другому вопросу", "а ещё" (explicit_marker)

2. **Назови каждый сегмент конкретно**.
   ✅ "Выбор сервиса транскрипции для invapp-panavto"
   ✅ "Статус оплаты счёта от Selectel"
   ❌ "Обсуждение рабочих вопросов" — слишком абстрактно
   ❌ "Разговор" — бесполезно

3. **Один сегмент** — одна тема обсуждения. Если в разговоре 3 темы — должно быть 3 сегмента.

4. **Каждое сообщение** принадлежит максимум одному сегменту.
   Сообщения, не относящиеся к теме (приветствия, emoji, "ок", "спасибо"), помести в skippedMessageIndices.

5. **Минимальный сегмент** — 2 сообщения. Одиночные сообщения без контекста пропускай.

6. **summary** — что обсуждалось и какой итог. Должно быть понятно без чтения сообщений.

7. **isWorkRelated** — true если обсуждение связано с работой, проектами, бизнесом. false для личных разговоров.

Заполни JSON строго по схеме.`;
  }

  /**
   * Validate and sanitize Claude's response.
   */
  private validateSegments(segments: DetectedSegment[], messageCount: number): DetectedSegment[] {
    if (!Array.isArray(segments)) return [];

    const usedIndices = new Set<number>();

    return segments
      .filter((s) => {
        // Must have a topic
        if (!s.topic || s.topic.length < 3) return false;
        // Must have message indices
        if (!Array.isArray(s.messageIndices) || s.messageIndices.length < 2) return false;
        // Confidence threshold
        if (s.confidence < 0.5) return false;
        return true;
      })
      .map((s) => {
        // Filter out invalid and duplicate indices
        const validIndices = s.messageIndices
          .filter((idx) => idx >= 0 && idx < messageCount && !usedIndices.has(idx));

        // Mark indices as used (one message = one segment)
        validIndices.forEach((idx) => usedIndices.add(idx));

        return {
          ...s,
          messageIndices: validIndices,
          keywords: Array.isArray(s.keywords) ? s.keywords.slice(0, 7) : [],
          confidence: Math.max(0, Math.min(1, s.confidence)),
        };
      })
      .filter((s) => s.messageIndices.length >= 2);
  }
}
