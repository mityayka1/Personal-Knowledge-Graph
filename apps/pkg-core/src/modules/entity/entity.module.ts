import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityRecord, EntityIdentifier, EntityFact } from '@pkg/entities';
import { EntityController } from './entity.controller';
import { EntityService } from './entity.service';
import { EntityIdentifierService } from './entity-identifier/entity-identifier.service';
import { EntityFactService } from './entity-fact/entity-fact.service';
import { FactFusionService } from './entity-fact/fact-fusion.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EntityRecord, EntityIdentifier, EntityFact]),
    EmbeddingModule,
    forwardRef(() => ClaudeAgentModule),
    forwardRef(() => NotificationModule),
  ],
  controllers: [EntityController],
  providers: [EntityService, EntityIdentifierService, EntityFactService, FactFusionService],
  exports: [EntityService, EntityIdentifierService, EntityFactService, FactFusionService],
})
export class EntityModule {}
