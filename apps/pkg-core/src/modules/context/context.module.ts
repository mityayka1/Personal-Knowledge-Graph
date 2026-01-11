import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Message,
  InteractionSummary,
  EntityRelationshipProfile,
  EntityFact,
  TranscriptSegment,
} from '@pkg/entities';
import { ContextController } from './context.controller';
import { ContextService } from './context.service';
import { EntityModule } from '../entity/entity.module';
import { InteractionModule } from '../interaction/interaction.module';
import { SearchModule } from '../search/search.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { ClaudeCliModule } from '../claude-cli/claude-cli.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Message,
      InteractionSummary,
      EntityRelationshipProfile,
      EntityFact,
      TranscriptSegment,
    ]),
    EntityModule,
    forwardRef(() => InteractionModule),
    SearchModule,
    EmbeddingModule,
    ClaudeCliModule,
  ],
  controllers: [ContextController],
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
