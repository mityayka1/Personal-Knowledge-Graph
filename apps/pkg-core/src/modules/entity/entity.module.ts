import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  EntityRecord,
  EntityIdentifier,
  EntityFact,
  EntityRelation,
  EntityRelationMember,
  DismissedMergeSuggestion,
} from '@pkg/entities';
import { EntityController } from './entity.controller';
import { EntityRelationController } from './entity-relation/entity-relation.controller';
import { MergeSuggestionController } from './merge-suggestion/merge-suggestion.controller';
import { EntityService } from './entity.service';
import { EntityIdentifierService } from './entity-identifier/entity-identifier.service';
import { EntityFactService } from './entity-fact/entity-fact.service';
import { FactFusionService } from './entity-fact/fact-fusion.service';
import { EntityRelationService } from './entity-relation/entity-relation.service';
import { MergeSuggestionService } from './merge-suggestion/merge-suggestion.service';
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
      DismissedMergeSuggestion,
    ]),
    EmbeddingModule,
    forwardRef(() => ClaudeAgentModule),
    forwardRef(() => NotificationModule),
  ],
  controllers: [EntityController, EntityRelationController, MergeSuggestionController],
  providers: [
    EntityService,
    EntityIdentifierService,
    EntityFactService,
    FactFusionService,
    EntityRelationService,
    MergeSuggestionService,
  ],
  exports: [
    EntityService,
    EntityIdentifierService,
    EntityFactService,
    FactFusionService,
    EntityRelationService,
    MergeSuggestionService,
  ],
})
export class EntityModule {}
