import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InteractionSummary, Decision, ActionItem, ToneType } from '@pkg/entities';

export interface CreateSummaryDto {
  summaryText: string;
  keyPoints?: string[];
  tone?: ToneType;
  decisions?: Decision[];
  actionItems?: ActionItem[];
  factsExtracted?: Array<{ type: string; value: string; confidence: number }>;
  // Optional metrics
  messageCount?: number;
  sourceTokenCount?: number;
  summaryTokenCount?: number;
  compressionRatio?: number;
  modelVersion?: string;
  generationCostUsd?: number;
}

// Legacy DTO for backwards compatibility
export interface LegacyCreateSummaryDto {
  summaryText: string;
  keyPoints?: string[];
  decisions?: string[];
  actionItems?: string[];
  factsExtracted?: Array<{ type: string; value: string; confidence: number }>;
}

@Injectable()
export class InteractionSummaryService {
  constructor(
    @InjectRepository(InteractionSummary)
    private summaryRepo: Repository<InteractionSummary>,
  ) {}

  /**
   * Create a new interaction summary
   */
  async create(interactionId: string, data: CreateSummaryDto): Promise<InteractionSummary> {
    const summary = this.summaryRepo.create({
      interactionId,
      summaryText: data.summaryText,
      keyPoints: data.keyPoints || [],
      tone: data.tone || null,
      decisions: data.decisions || [],
      actionItems: data.actionItems || [],
      factsExtracted: data.factsExtracted || null,
      importantMessages: [],
      messageCount: data.messageCount || null,
      sourceTokenCount: data.sourceTokenCount || null,
      summaryTokenCount: data.summaryTokenCount || null,
      compressionRatio: data.compressionRatio || null,
      modelVersion: data.modelVersion || null,
      generationCostUsd: data.generationCostUsd || null,
      revisionCount: 1,
    });

    return this.summaryRepo.save(summary);
  }

  /**
   * Legacy create method for backwards compatibility
   * Converts string[] decisions/actionItems to structured format
   */
  async createLegacy(interactionId: string, data: LegacyCreateSummaryDto): Promise<InteractionSummary> {
    const convertedData: CreateSummaryDto = {
      summaryText: data.summaryText,
      keyPoints: data.keyPoints,
      decisions: data.decisions?.map(d => ({
        description: d,
        date: null,
        importance: 'medium' as const,
      })) || [],
      actionItems: data.actionItems?.map(a => ({
        description: a,
        owner: 'self' as const,
        status: 'open' as const,
      })) || [],
      factsExtracted: data.factsExtracted,
    };

    return this.create(interactionId, convertedData);
  }

  async findByInteraction(interactionId: string): Promise<InteractionSummary | null> {
    return this.summaryRepo.findOne({ where: { interactionId } });
  }

  async update(id: string, data: Partial<CreateSummaryDto>): Promise<InteractionSummary | null> {
    // Apply provided updates
    await this.summaryRepo.update(id, data);
    // Safely increment revisionCount without bypassing TypeScript's type system
    await this.summaryRepo.increment({ id }, 'revisionCount', 1);
    return this.summaryRepo.findOne({ where: { id } });
  }
}
