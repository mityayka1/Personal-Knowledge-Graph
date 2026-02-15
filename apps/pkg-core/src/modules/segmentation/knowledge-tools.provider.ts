import { Injectable, Logger } from '@nestjs/common';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  TopicalSegment,
  KnowledgePack,
  EntityFact,
  Commitment,
  SegmentStatus,
  PackStatus,
} from '@pkg/entities';
import {
  toolSuccess,
  toolEmptyResult,
  toolError,
  handleToolError,
  type ToolDefinition,
} from '../claude-agent/tools/tool.types';
import { SegmentationService } from './segmentation.service';

/**
 * Maximum content preview length for message snippets in discussion context
 */
const MAX_MESSAGE_PREVIEW_LENGTH = 300;

/**
 * Provider for knowledge/segmentation-related tools.
 *
 * Enables Claude to:
 * - Search discussion segments by topic, participant, or chat
 * - Get full context of a discussion segment with messages
 * - Get consolidated knowledge summaries (KnowledgePacks)
 * - Trace facts and commitments back to source discussion segments
 */
@Injectable()
export class KnowledgeToolsProvider {
  private readonly logger = new Logger(KnowledgeToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;

  constructor(
    private readonly segmentationService: SegmentationService,
    @InjectRepository(TopicalSegment)
    private readonly segmentRepo: Repository<TopicalSegment>,
    @InjectRepository(KnowledgePack)
    private readonly packRepo: Repository<KnowledgePack>,
    @InjectRepository(EntityFact)
    private readonly factRepo: Repository<EntityFact>,
    @InjectRepository(Commitment)
    private readonly commitmentRepo: Repository<Commitment>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Check if tools are available
   */
  hasTools(): boolean {
    return true;
  }

  /**
   * Get knowledge tools (cached)
   */
  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
      this.logger.debug(`Created ${this.cachedTools.length} knowledge tools`);
    }
    return this.cachedTools;
  }

  /**
   * Create tool definitions
   */
  private createTools(): ToolDefinition[] {
    return [
      this.searchDiscussionsTool(),
      this.getDiscussionContextTool(),
      this.getKnowledgeSummaryTool(),
      this.traceFactSourceTool(),
    ] as ToolDefinition[];
  }

  // ─────────────────────────────────────────────────────────────
  // Tool 1: search_discussions
  // ─────────────────────────────────────────────────────────────

  private searchDiscussionsTool() {
    return tool(
      'search_discussions',
      `Search discussion segments by topic keywords, participant, or chat.
Returns matching segments with their topics, summaries, dates, and message counts.
Use to find past discussions about a specific theme or involving a specific person.`,
      {
        query: z.string().min(2).describe('Search query - topic keywords or theme to search for'),
        chatId: z.string().optional().describe('Filter by Telegram chat ID'),
        participantId: z.string().uuid().optional().describe('Filter by participant entity UUID'),
        activityId: z.string().uuid().optional().describe('Filter by activity UUID'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max results to return'),
      },
      async (args) => {
        try {
          const qb = this.segmentRepo.createQueryBuilder('s')
            .leftJoinAndSelect('s.activity', 'activity')
            .leftJoinAndSelect('s.primaryParticipant', 'participant');

          // Topic search: ILIKE on topic and summary, or keyword array overlap
          qb.andWhere(
            '(s.topic ILIKE :search OR s.summary ILIKE :search OR :queryText = ANY(s.keywords))',
            {
              search: `%${args.query}%`,
              queryText: args.query.toLowerCase(),
            },
          );

          if (args.chatId) {
            qb.andWhere('s.chatId = :chatId', { chatId: args.chatId });
          }

          if (args.participantId) {
            qb.andWhere(':participantId = ANY(s.participant_ids)', {
              participantId: args.participantId,
            });
          }

          if (args.activityId) {
            qb.andWhere('s.activityId = :activityId', { activityId: args.activityId });
          }

          // Exclude merged segments
          qb.andWhere('s.status != :mergedStatus', { mergedStatus: SegmentStatus.MERGED });

          qb.orderBy('s.startedAt', 'DESC')
            .take(args.limit);

          const segments = await qb.getMany();

          if (segments.length === 0) {
            return toolEmptyResult(
              'discussion segments matching your query',
              'Try broader keywords, remove filters, or check spelling.',
            );
          }

          const results = segments.map((s) => ({
            id: s.id,
            topic: s.topic,
            summary: s.summary,
            keywords: s.keywords,
            chatId: s.chatId,
            messageCount: s.messageCount,
            startedAt: s.startedAt.toISOString(),
            endedAt: s.endedAt.toISOString(),
            status: s.status,
            activityId: s.activityId,
            activityName: s.activity?.name || null,
            primaryParticipant: s.primaryParticipant?.name || null,
            participantCount: s.participantIds?.length || 0,
            confidence: s.confidence,
            relatedSegmentCount: s.relatedSegmentIds?.length || 0,
          }));

          return toolSuccess({
            total: results.length,
            segments: results,
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'search_discussions');
        }
      },
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Tool 2: get_discussion_context
  // ─────────────────────────────────────────────────────────────

  private getDiscussionContextTool() {
    return tool(
      'get_discussion_context',
      `Get full context of a discussion segment including its messages, participants, and linked segments.
Use to understand what was discussed in a specific conversation segment.`,
      {
        segmentId: z.string().uuid().describe('TopicalSegment UUID to get context for'),
      },
      async (args) => {
        try {
          // Load segment with relations
          const segment = await this.segmentRepo.findOne({
            where: { id: args.segmentId },
            relations: ['activity', 'primaryParticipant', 'messages'],
          });

          if (!segment) {
            return toolError(
              `Segment with id '${args.segmentId}' not found`,
              'Use search_discussions to find valid segment IDs.',
            );
          }

          // Load messages via join table if not already loaded
          let messages = segment.messages;
          if (!messages || messages.length === 0) {
            // Load messages through the join table with sender info
            messages = await this.dataSource.query(
              `SELECT m.id, m.content, m.timestamp, m.is_outgoing,
                      e.name as sender_name
               FROM segment_messages sm
               JOIN messages m ON m.id = sm.message_id
               LEFT JOIN entities e ON e.id = m.sender_entity_id
               WHERE sm.segment_id = $1
               ORDER BY m.timestamp ASC`,
              [args.segmentId],
            );
          }

          // Format messages for output
          const formattedMessages = (messages || []).map((m: any) => ({
            id: m.id,
            content: m.content
              ? m.content.slice(0, MAX_MESSAGE_PREVIEW_LENGTH) +
                (m.content.length > MAX_MESSAGE_PREVIEW_LENGTH ? '...' : '')
              : null,
            timestamp: m.timestamp instanceof Date
              ? m.timestamp.toISOString()
              : m.timestamp,
            sender: m.sender_name || m.senderEntity?.name || (m.is_outgoing || m.isOutgoing ? 'You' : 'Unknown'),
            isOutgoing: m.is_outgoing ?? m.isOutgoing ?? false,
          }));

          // Load extracted facts count
          const extractedFactsCount = segment.extractedFactIds?.length || 0;
          const extractedCommitmentsCount = segment.extractedCommitmentIds?.length || 0;

          return toolSuccess({
            id: segment.id,
            topic: segment.topic,
            summary: segment.summary,
            keywords: segment.keywords,
            chatId: segment.chatId,
            status: segment.status,
            confidence: segment.confidence,
            startedAt: segment.startedAt.toISOString(),
            endedAt: segment.endedAt.toISOString(),
            activity: segment.activity ? {
              id: segment.activity.id,
              name: segment.activity.name,
            } : null,
            primaryParticipant: segment.primaryParticipant ? {
              id: segment.primaryParticipant.id,
              name: segment.primaryParticipant.name,
            } : null,
            participantIds: segment.participantIds,
            messageCount: segment.messageCount,
            messages: formattedMessages,
            extractedFactsCount,
            extractedCommitmentsCount,
            extractedFactIds: segment.extractedFactIds,
            extractedCommitmentIds: segment.extractedCommitmentIds,
            relatedSegmentIds: segment.relatedSegmentIds,
            metadata: segment.metadata,
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'get_discussion_context');
        }
      },
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Tool 3: get_knowledge_summary
  // ─────────────────────────────────────────────────────────────

  private getKnowledgeSummaryTool() {
    return tool(
      'get_knowledge_summary',
      `Get consolidated knowledge summaries (KnowledgePacks) for an activity or entity.
Shows synthesized conclusions from multiple discussion segments including decisions, open questions, and key facts.
Provide either activityId or entityId (at least one is required).`,
      {
        activityId: z.string().uuid().optional().describe('Activity UUID to get knowledge packs for'),
        entityId: z.string().uuid().optional().describe('Entity UUID to get knowledge packs for (packs where entity is participant)'),
        limit: z.number().int().min(1).max(20).default(5).describe('Max packs to return'),
      },
      async (args) => {
        try {
          if (!args.activityId && !args.entityId) {
            return toolError(
              'Either activityId or entityId must be provided',
              'Specify at least one filter to search knowledge packs.',
            );
          }

          const qb = this.packRepo.createQueryBuilder('kp')
            .leftJoinAndSelect('kp.activity', 'activity')
            .leftJoinAndSelect('kp.entity', 'entity');

          if (args.activityId) {
            qb.andWhere('kp.activityId = :activityId', { activityId: args.activityId });
          }

          if (args.entityId) {
            // Match packs where entityId is set directly OR entity is in participantIds
            qb.andWhere(
              '(kp.entityId = :entityId OR :entityId = ANY(kp.participant_ids))',
              { entityId: args.entityId },
            );
          }

          // Only active and draft packs (exclude superseded/archived)
          qb.andWhere('kp.status IN (:...statuses)', {
            statuses: [PackStatus.ACTIVE, PackStatus.DRAFT],
          });

          qb.orderBy('kp.periodEnd', 'DESC')
            .take(args.limit);

          const packs = await qb.getMany();

          if (packs.length === 0) {
            return toolEmptyResult(
              'knowledge packs matching your criteria',
              'Knowledge packs are created from discussion segments. Check if segments exist first using search_discussions.',
            );
          }

          const results = packs.map((kp) => ({
            id: kp.id,
            title: kp.title,
            packType: kp.packType,
            summary: kp.summary,
            decisions: kp.decisions,
            openQuestions: kp.openQuestions,
            keyFacts: kp.keyFacts,
            segmentCount: kp.segmentCount,
            totalMessageCount: kp.totalMessageCount,
            status: kp.status,
            isVerified: kp.isVerified,
            periodStart: kp.periodStart.toISOString(),
            periodEnd: kp.periodEnd.toISOString(),
            activity: kp.activity ? {
              id: kp.activity.id,
              name: kp.activity.name,
            } : null,
            entity: kp.entity ? {
              id: kp.entity.id,
              name: kp.entity.name,
            } : null,
            participantIds: kp.participantIds,
            sourceSegmentIds: kp.sourceSegmentIds,
            conflicts: kp.conflicts?.length > 0 ? kp.conflicts : undefined,
            createdAt: kp.createdAt.toISOString(),
          }));

          return toolSuccess({
            total: results.length,
            packs: results,
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'get_knowledge_summary');
        }
      },
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Tool 4: trace_fact_source
  // ─────────────────────────────────────────────────────────────

  private traceFactSourceTool() {
    return tool(
      'trace_fact_source',
      `Trace a fact or commitment back to its source discussion segment.
Shows which conversation led to this knowledge, providing traceability.
Provide either factId or commitmentId (at least one is required).`,
      {
        factId: z.string().uuid().optional().describe('EntityFact UUID to trace back to source segment'),
        commitmentId: z.string().uuid().optional().describe('Commitment UUID to trace back to source segment'),
      },
      async (args) => {
        try {
          if (!args.factId && !args.commitmentId) {
            return toolError(
              'Either factId or commitmentId must be provided',
              'Specify the fact or commitment you want to trace.',
            );
          }

          let sourceSegmentId: string | null = null;
          let sourceType: 'fact' | 'commitment';
          let sourceInfo: Record<string, unknown> = {};

          if (args.factId) {
            sourceType = 'fact';
            const fact = await this.factRepo.findOne({
              where: { id: args.factId },
              relations: ['entity'],
            });

            if (!fact) {
              return toolError(
                `Fact with id '${args.factId}' not found`,
                'Use search tools to find valid fact IDs.',
              );
            }

            sourceSegmentId = fact.sourceSegmentId;
            sourceInfo = {
              factId: fact.id,
              factType: fact.factType,
              value: fact.value,
              category: fact.category,
              confidence: fact.confidence,
              entityName: fact.entity?.name || null,
              source: fact.source,
              createdAt: fact.createdAt.toISOString(),
            };

            // If no direct sourceSegmentId, try reverse lookup via extractedFactIds
            if (!sourceSegmentId) {
              const segmentWithFact = await this.segmentRepo
                .createQueryBuilder('s')
                .where(':factId = ANY(s.extracted_fact_ids)', { factId: args.factId })
                .orderBy('s.startedAt', 'DESC')
                .getOne();

              if (segmentWithFact) {
                sourceSegmentId = segmentWithFact.id;
              }
            }
          } else if (args.commitmentId) {
            sourceType = 'commitment';
            const commitment = await this.commitmentRepo.findOne({
              where: { id: args.commitmentId },
              relations: ['fromEntity', 'toEntity', 'activity'],
            });

            if (!commitment) {
              return toolError(
                `Commitment with id '${args.commitmentId}' not found`,
                'Use search tools to find valid commitment IDs.',
              );
            }

            sourceSegmentId = commitment.sourceSegmentId;
            sourceInfo = {
              commitmentId: commitment.id,
              title: commitment.title,
              type: commitment.type,
              status: commitment.status,
              fromEntity: commitment.fromEntity?.name || null,
              toEntity: commitment.toEntity?.name || null,
              activityName: commitment.activity?.name || null,
              dueDate: commitment.dueDate?.toISOString() || null,
              confidence: commitment.confidence,
              createdAt: commitment.createdAt.toISOString(),
            };

            // If no direct sourceSegmentId, try reverse lookup via extractedCommitmentIds
            if (!sourceSegmentId) {
              const segmentWithCommitment = await this.segmentRepo
                .createQueryBuilder('s')
                .where(':commitmentId = ANY(s.extracted_commitment_ids)', {
                  commitmentId: args.commitmentId,
                })
                .orderBy('s.startedAt', 'DESC')
                .getOne();

              if (segmentWithCommitment) {
                sourceSegmentId = segmentWithCommitment.id;
              }
            }
          }

          // Load the source segment if found
          if (sourceSegmentId) {
            const segment = await this.segmentRepo.findOne({
              where: { id: sourceSegmentId },
              relations: ['activity', 'primaryParticipant'],
            });

            if (segment) {
              return toolSuccess({
                traced: true,
                sourceType: sourceType!,
                source: sourceInfo,
                segment: {
                  id: segment.id,
                  topic: segment.topic,
                  summary: segment.summary,
                  keywords: segment.keywords,
                  chatId: segment.chatId,
                  startedAt: segment.startedAt.toISOString(),
                  endedAt: segment.endedAt.toISOString(),
                  messageCount: segment.messageCount,
                  status: segment.status,
                  activity: segment.activity ? {
                    id: segment.activity.id,
                    name: segment.activity.name,
                  } : null,
                  primaryParticipant: segment.primaryParticipant ? {
                    id: segment.primaryParticipant.id,
                    name: segment.primaryParticipant.name,
                  } : null,
                  participantIds: segment.participantIds,
                },
              });
            }
          }

          // No source segment found
          return toolSuccess({
            traced: false,
            sourceType: sourceType!,
            source: sourceInfo,
            segment: null,
            hint: 'No source segment found for this item. It may have been created before segmentation was enabled, or the source segment link was not recorded.',
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'trace_fact_source');
        }
      },
    );
  }
}
