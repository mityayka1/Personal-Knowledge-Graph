import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityRecord, EntityIdentifier, EntityFact } from '@pkg/entities';
import { EntityController } from './entity.controller';
import { EntityService } from './entity.service';
import { EntityIdentifierService } from './entity-identifier/entity-identifier.service';
import { EntityFactService } from './entity-fact/entity-fact.service';
import { EmbeddingModule } from '../embedding/embedding.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EntityRecord, EntityIdentifier, EntityFact]),
    EmbeddingModule,
  ],
  controllers: [EntityController],
  providers: [EntityService, EntityIdentifierService, EntityFactService],
  exports: [EntityService, EntityIdentifierService, EntityFactService],
})
export class EntityModule {}
