import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { EntityFact, FactSource } from '@pkg/entities';
import { CreateFactDto } from '../dto/create-entity.dto';

@Injectable()
export class EntityFactService {
  constructor(
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
  ) {}

  async create(entityId: string, dto: CreateFactDto) {
    const fact = this.factRepo.create({
      entityId,
      factType: dto.type,
      category: dto.category,
      value: dto.value,
      valueDate: dto.valueDate,
      valueJson: dto.valueJson,
      source: dto.source || FactSource.MANUAL,
      validFrom: new Date(),
    });

    return this.factRepo.save(fact);
  }

  async findByEntity(entityId: string, includeHistory = false) {
    const where: any = { entityId };

    if (!includeHistory) {
      where.validUntil = IsNull();
    }

    return this.factRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async moveToEntity(fromEntityId: string, toEntityId: string) {
    const result = await this.factRepo.update(
      { entityId: fromEntityId },
      { entityId: toEntityId },
    );
    return result.affected || 0;
  }

  async invalidate(factId: string) {
    const result = await this.factRepo.update(factId, {
      validUntil: new Date(),
    });
    return result.affected === 1;
  }
}
