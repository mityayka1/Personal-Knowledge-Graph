import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InteractionSummary } from '@pkg/entities';

@Injectable()
export class InteractionSummaryService {
  constructor(
    @InjectRepository(InteractionSummary)
    private summaryRepo: Repository<InteractionSummary>,
  ) {}

  async create(interactionId: string, data: {
    summaryText: string;
    keyPoints?: string[];
    decisions?: string[];
    actionItems?: string[];
    factsExtracted?: Array<{ type: string; value: string; confidence: number }>;
  }) {
    const summary = this.summaryRepo.create({
      interactionId,
      summaryText: data.summaryText,
      keyPoints: data.keyPoints,
      decisions: data.decisions,
      actionItems: data.actionItems,
      factsExtracted: data.factsExtracted,
    });

    return this.summaryRepo.save(summary);
  }

  async findByInteraction(interactionId: string) {
    return this.summaryRepo.findOne({ where: { interactionId } });
  }
}
