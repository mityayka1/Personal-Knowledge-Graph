import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Message,
  InteractionSummary,
  EntityRelationshipProfile,
  EntityFact,
  TranscriptSegment,
  KnowledgePack,
} from '@pkg/entities';
import { ContextController } from './context.controller';
import { ContextService } from './context.service';
import { GraphTraversalService } from './graph-traversal.service';
import { EntityModule } from '../entity/entity.module';
import { InteractionModule } from '../interaction/interaction.module';
import { SearchModule } from '../search/search.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { ClaudeAgentCoreModule } from '../claude-agent/claude-agent-core.module';
import { ContextToolsProvider } from '../claude-agent/tools';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Message,
      InteractionSummary,
      EntityRelationshipProfile,
      EntityFact,
      TranscriptSegment,
      KnowledgePack,
    ]),
    forwardRef(() => EntityModule),
    forwardRef(() => InteractionModule),
    SearchModule,
    EmbeddingModule,
    ClaudeAgentCoreModule,
  ],
  controllers: [ContextController],
  providers: [ContextService, GraphTraversalService, ContextToolsProvider],
  exports: [ContextService, GraphTraversalService],
})
export class ContextModule {}
