/**
 * Единственный источник правды для всех TypeORM entities.
 * Импортируется в:
 * - data-source.ts (CLI миграции)
 * - database.config.ts (NestJS runtime)
 *
 * При добавлении новой entity — добавляй ТОЛЬКО сюда!
 */
import {
  EntityRecord,
  EntityIdentifier,
  EntityFact,
  Interaction,
  InteractionParticipant,
  Message,
  TranscriptSegment,
  InteractionSummary,
  PendingEntityResolution,
  PendingFact,
  Job,
  Setting,
  ChatCategoryRecord,
  GroupMembership,
  EntityEvent,
  EntityRelationshipProfile,
  EntityRelation,
  EntityRelationMember,
  ClaudeCliRun,
  ClaudeAgentRun,
  User,
  ExtractedEvent,
  PendingApproval,
  // Phase D: Jarvis Foundation
  Activity,
  ActivityMember,
  Commitment,
} from '@pkg/entities';

/**
 * Все TypeORM entities приложения.
 * Единственный источник правды.
 */
export const ALL_ENTITIES = [
  EntityRecord,
  EntityIdentifier,
  EntityFact,
  Interaction,
  InteractionParticipant,
  Message,
  TranscriptSegment,
  InteractionSummary,
  PendingEntityResolution,
  PendingFact,
  Job,
  Setting,
  ChatCategoryRecord,
  GroupMembership,
  EntityEvent,
  EntityRelationshipProfile,
  EntityRelation,
  EntityRelationMember,
  ClaudeCliRun,
  ClaudeAgentRun,
  User,
  ExtractedEvent,
  PendingApproval,
  // Phase D: Jarvis Foundation
  Activity,
  ActivityMember,
  Commitment,
] as const;
