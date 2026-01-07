import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PendingFact, PendingFactStatus } from '@pkg/entities';

@Injectable()
export class PendingFactService {
  constructor(
    @InjectRepository(PendingFact)
    private pendingFactRepo: Repository<PendingFact>,
  ) {}

  async findAll(status?: PendingFactStatus, limit = 50, offset = 0) {
    const where = status ? { status } : {};

    const [items, total] = await this.pendingFactRepo.findAndCount({
      where,
      relations: ['entity'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { items, total };
  }

  async findOne(id: string) {
    const fact = await this.pendingFactRepo.findOne({
      where: { id },
      relations: ['entity', 'sourceInteraction', 'sourceMessage'],
    });

    if (!fact) {
      throw new NotFoundException(`PendingFact with id '${id}' not found`);
    }

    return fact;
  }

  async create(data: {
    entityId: string;
    factType: string;
    value?: string;
    valueDate?: Date;
    confidence: number;
    sourceQuote?: string;
    sourceInteractionId?: string;
    sourceMessageId?: string;
  }) {
    const pendingFact = this.pendingFactRepo.create({
      ...data,
      status: PendingFactStatus.PENDING,
    });

    return this.pendingFactRepo.save(pendingFact);
  }

  async approve(id: string) {
    const fact = await this.findOne(id);

    fact.status = PendingFactStatus.APPROVED;
    fact.reviewedAt = new Date();

    return this.pendingFactRepo.save(fact);
  }

  async reject(id: string) {
    const fact = await this.findOne(id);

    fact.status = PendingFactStatus.REJECTED;
    fact.reviewedAt = new Date();

    return this.pendingFactRepo.save(fact);
  }
}
