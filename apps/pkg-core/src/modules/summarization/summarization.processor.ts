import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SummarizationService } from './summarization.service';

interface SummarizationJobData {
  interactionId: string;
}

@Processor('summarization')
export class SummarizationProcessor extends WorkerHost {
  private readonly logger = new Logger(SummarizationProcessor.name);

  constructor(private readonly summarizationService: SummarizationService) {
    super();
  }

  async process(job: Job<SummarizationJobData>): Promise<{ success: boolean; summaryId?: string }> {
    const { interactionId } = job.data;
    this.logger.debug(`Processing summarization job for interaction ${interactionId}`);

    try {
      const summary = await this.summarizationService.processSummarization(interactionId);

      if (summary) {
        this.logger.log(`Successfully summarized interaction ${interactionId} → summary ${summary.id}`);
        return { success: true, summaryId: summary.id };
      } else {
        this.logger.debug(`Interaction ${interactionId} skipped (already summarized or too few messages)`);
        return { success: true, summaryId: undefined };
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Summarization failed for interaction ${interactionId}: ${err.message}`,
        err.stack,
      );
      throw error; // Re-throw to trigger BullMQ retry
    }
  }
}
