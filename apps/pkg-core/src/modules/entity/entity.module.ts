import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  EntityRecord,
  EntityIdentifier,
  EntityFact,
  EntityRelation,
  EntityRelationMember,
} from '@pkg/entities';
import { EntityController } from './entity.controller';
import { EntityService } from './entity.service';
import { EntityIdentifierService } from './entity-identifier/entity-identifier.service';
import { EntityFactService } from './entity-fact/entity-fact.service';
import { FactFusionService } from './entity-fact/fact-fusion.service';
import { EntityRelationService } from './entity-relation/entity-relation.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EntityRecord,
      EntityIdentifier,
      EntityFact,
      EntityRelation,
      EntityRelationMember,
    ]),
    EmbeddingModule,
    forwardRef(() => ClaudeAgentModule),
    forwardRef(() => NotificationModule),
  ],
  controllers: [EntityController],
  providers: [
    EntityService,
    EntityIdentifierService,
    EntityFactService,
    FactFusionService,
    EntityRelationService,
  ],
  exports: [
    EntityService,
    EntityIdentifierService,
    EntityFactService,
    FactFusionService,
    EntityRelationService,
  ],
})
export class EntityModule {}
