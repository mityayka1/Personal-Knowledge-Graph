import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Job, JobType, JobStatus } from '@pkg/entities';

@Injectable()
export class JobService {
  constructor(
    @InjectRepository(Job)
    private jobRepo: Repository<Job>,
    @InjectQueue('embedding')
    private embeddingQueue: Queue,
  ) {}

  async createEmbeddingJob(data: { messageId: string; content: string }) {
    // Create job record
    const job = this.jobRepo.create({
      type: JobType.EMBEDDING,
      status: JobStatus.PENDING,
      payload: data,
    });

    const savedJob = await this.jobRepo.save(job);

    // Add to BullMQ queue
    await this.embeddingQueue.add('generate', {
      jobId: savedJob.id,
      ...data,
    });

    return savedJob;
  }

  async updateStatus(id: string, status: JobStatus, result?: any, error?: string) {
    await this.jobRepo.update(id, {
      status,
      result,
      error,
      completedAt: status === JobStatus.COMPLETED || status === JobStatus.FAILED
        ? new Date()
        : undefined,
      startedAt: status === JobStatus.PROCESSING ? new Date() : undefined,
    });
  }

  async incrementAttempts(id: string) {
    await this.jobRepo.increment({ id }, 'attempts', 1);
  }
}
