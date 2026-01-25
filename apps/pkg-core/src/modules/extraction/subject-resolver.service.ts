import { Injectable, Logger } from '@nestjs/common';
import {
  PendingConfirmationType,
  ConfirmationOption,
  ConfirmationContext,
  CONFIDENCE_THRESHOLDS,
  EXACT_MATCH_CONFIDENCE_BONUS,
} from '@pkg/entities';
import { EntityService } from '../entity/entity.service';
import { ConfirmationService } from '../confirmation/confirmation.service';
import { SubjectResolution, SubjectCandidate } from './extraction.types';

/**
 * Maximum number of candidates to show in confirmation options.
 */
const MAX_CONFIRMATION_OPTIONS = 5;

/**
 * Service for resolving the subject (owner) of extracted facts.
 *
 * When a fact mentions "Игорь" or "wife", this service determines who that refers to:
 * 1. Search entities by name
 * 2. Prioritize conversation participants
 * 3. Auto-resolve if confident, otherwise create confirmation
 *
 * Decision matrix:
 * - 1 participant match + high confidence → resolved
 * - Multiple matches or low confidence → pending (confirmation needed)
 * - No matches → unknown (may create new entity later)
 */
@Injectable()
export class SubjectResolverService {
  private readonly logger = new Logger(SubjectResolverService.name);

  constructor(
    private readonly entityService: EntityService,
    private readonly confirmationService: ConfirmationService,
  ) {}

  /**
   * Resolve the subject of a fact based on mention text.
   *
   * @param subjectMention - The text mentioning the subject (e.g., "Игорь", "моя жена")
   * @param conversationParticipants - Entity IDs of people in the conversation
   * @param confidence - LLM confidence in the extraction (0-1)
   * @param options - Optional parameters for linking
   * @param options.sourcePendingFactId - ID of the pending fact for linking
   * @param options.sourceExtractedEventId - ID of the extracted event for linking
   * @param options.sourceQuote - Source quote for context
   * @returns Resolution result: resolved, pending, or unknown
   */
  async resolve(
    subjectMention: string,
    conversationParticipants: string[],
    confidence: number,
    options?: {
      sourcePendingFactId?: string;
      sourceExtractedEventId?: string;
      sourceQuote?: string;
    },
  ): Promise<SubjectResolution> {
    this.logger.debug(
      `Resolving subject "${subjectMention}" with confidence ${confidence}, ` +
        `${conversationParticipants.length} participants`,
    );

    // 1. Search entities by name
    const candidates = await this.searchByName(subjectMention);

    // 2. Identify which candidates are conversation participants
    const candidatesWithParticipantFlag = this.markParticipants(
      candidates,
      conversationParticipants,
    );

    // 3. Get participant matches (higher priority)
    const participantMatches = candidatesWithParticipantFlag.filter(
      (c) => c.isParticipant,
    );

    // 4. Decision matrix
    return this.decideResolution(
      subjectMention,
      candidatesWithParticipantFlag,
      participantMatches,
      confidence,
      options,
    );
  }

  /**
   * Search entities by name using EntityService.
   */
  private async searchByName(name: string): Promise<SubjectCandidate[]> {
    if (!name || name.trim().length < 2) {
      return [];
    }

    const result = await this.entityService.findAll({
      search: name.trim(),
      limit: 10,
    });

    return result.items.map((entity) => ({
      id: entity.id,
      name: entity.name,
      displayName: entity.name, // EntityRecord uses 'name' as display name
      isParticipant: false, // Will be marked later
    }));
  }

  /**
   * Mark candidates that are conversation participants.
   */
  private markParticipants(
    candidates: SubjectCandidate[],
    participantIds: string[],
  ): SubjectCandidate[] {
    const participantSet = new Set(participantIds);

    return candidates.map((candidate) => ({
      ...candidate,
      isParticipant: participantSet.has(candidate.id),
    }));
  }

  /**
   * Decision matrix for subject resolution.
   */
  private async decideResolution(
    subjectMention: string,
    allCandidates: SubjectCandidate[],
    participantMatches: SubjectCandidate[],
    confidence: number,
    options?: {
      sourcePendingFactId?: string;
      sourceExtractedEventId?: string;
      sourceQuote?: string;
    },
  ): Promise<SubjectResolution> {
    // Case 1: Exactly one participant match with high confidence → auto-resolve
    if (
      participantMatches.length === 1 &&
      confidence >= CONFIDENCE_THRESHOLDS.AUTO_RESOLVE
    ) {
      this.logger.log(
        `Auto-resolved subject "${subjectMention}" to entity ${participantMatches[0].id}`,
      );
      return {
        status: 'resolved',
        entityId: participantMatches[0].id,
      };
    }

    // Case 2: Multiple participant matches or low confidence → need confirmation
    if (
      participantMatches.length > 1 ||
      (participantMatches.length === 1 &&
        confidence < CONFIDENCE_THRESHOLDS.AUTO_RESOLVE)
    ) {
      const confirmation = await this.createConfirmation(
        subjectMention,
        participantMatches,
        allCandidates,
        confidence,
        options,
      );
      return {
        status: 'pending',
        confirmationId: confirmation.id,
      };
    }

    // Case 3: No participant matches but other candidates exist → need confirmation
    if (allCandidates.length > 0) {
      const confirmation = await this.createConfirmation(
        subjectMention,
        [],
        allCandidates,
        confidence,
        options,
      );
      return {
        status: 'pending',
        confirmationId: confirmation.id,
      };
    }

    // Case 4: No matches at all → unknown
    this.logger.debug(`No matches found for subject "${subjectMention}"`);
    return {
      status: 'unknown',
      suggestedName: subjectMention,
    };
  }

  /**
   * Create a confirmation request for subject resolution.
   */
  private async createConfirmation(
    subjectMention: string,
    participantMatches: SubjectCandidate[],
    allCandidates: SubjectCandidate[],
    confidence: number,
    resolveOptions?: {
      sourcePendingFactId?: string;
      sourceExtractedEventId?: string;
      sourceQuote?: string;
    },
  ): Promise<{ id: string }> {
    const context: ConfirmationContext = {
      title: 'О ком этот факт?',
      description: `Упоминание: "${subjectMention}"`,
      sourceQuote: resolveOptions?.sourceQuote,
    };

    const options = this.buildConfirmationOptions(
      participantMatches,
      allCandidates,
    );

    const confirmation = await this.confirmationService.create({
      type: PendingConfirmationType.FACT_SUBJECT,
      context,
      options,
      confidence,
      sourcePendingFactId: resolveOptions?.sourcePendingFactId,
      sourceExtractedEventId: resolveOptions?.sourceExtractedEventId,
    });

    this.logger.log(
      `Created subject confirmation ${confirmation.id} for "${subjectMention}"`,
    );

    return confirmation;
  }

  /**
   * Build confirmation options from candidates.
   * Participant matches come first, then other candidates.
   */
  private buildConfirmationOptions(
    participantMatches: SubjectCandidate[],
    allCandidates: SubjectCandidate[],
  ): ConfirmationOption[] {
    const options: ConfirmationOption[] = [];

    // Add participant matches first (with priority indicator)
    for (const candidate of participantMatches.slice(
      0,
      MAX_CONFIRMATION_OPTIONS,
    )) {
      options.push({
        id: `entity-${candidate.id}`,
        label: candidate.displayName || candidate.name,
        sublabel: '(участник беседы)',
        entityId: candidate.id,
      });
    }

    // Add remaining candidates (non-participants)
    const nonParticipants = allCandidates.filter((c) => !c.isParticipant);
    const remainingSlots = MAX_CONFIRMATION_OPTIONS - options.length;

    for (const candidate of nonParticipants.slice(0, remainingSlots)) {
      options.push({
        id: `entity-${candidate.id}`,
        label: candidate.displayName || candidate.name,
        entityId: candidate.id,
      });
    }

    // Add "Create new" option
    options.push({
      id: 'create-new',
      label: 'Создать новый контакт',
      isCreateNew: true,
    });

    // Add "Skip" option
    options.push({
      id: 'decline',
      label: 'Пропустить',
      isDecline: true,
    });

    return options;
  }
}
