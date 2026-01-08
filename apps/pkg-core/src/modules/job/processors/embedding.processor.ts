import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, forwardRef } from '@nestjs/common';
import { Job as BullJob } from 'bullmq';
import { EmbeddingService } from '../../embedding/embedding.service';
import { MessageService } from '../../interaction/message/message.service';
import { JobService } from '../job.service';
import { JobStatus } from '@pkg/entities';

@Processor('embedding')
export class EmbeddingProcessor extends WorkerHost {
  constructor(
    private embeddingService: EmbeddingService,
    @Inject(forwardRef(() => MessageService))
    private messageService: MessageService,
    private jobService: JobService,
  ) {
    super();
  }

  async process(job: BullJob<{ jobId: string; messageId: string; content: string }>) {
    const { jobId, messageId, content } = job.data;

    try {
      await this.jobService.updateStatus(jobId, JobStatus.PROCESSING);

      // Generate embedding
      const embedding = await this.embeddingService.generate(content);

      // Update message with embedding
      await this.messageService.updateEmbedding(messageId, embedding);

      await this.jobService.updateStatus(jobId, JobStatus.COMPLETED, { embedding_length: embedding.length });

      return { success: true };
    } catch (error: any) {
      await this.jobService.incrementAttempts(jobId);
      await this.jobService.updateStatus(jobId, JobStatus.FAILED, undefined, error.message);

      throw error;
    }
  }
}
