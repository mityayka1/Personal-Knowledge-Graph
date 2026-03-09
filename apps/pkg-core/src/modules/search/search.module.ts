import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message, TranscriptSegment, InteractionSummary } from '@pkg/entities';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { FtsService } from './fts.service';
import { VectorService } from './vector.service';
import { RerankerService } from './reranker.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { ClaudeAgentCoreModule } from '../claude-agent/claude-agent-core.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message, TranscriptSegment, InteractionSummary]),
    EmbeddingModule,
    ClaudeAgentCoreModule,
  ],
  controllers: [SearchController],
  providers: [SearchService, FtsService, VectorService, RerankerService],
  exports: [SearchService, VectorService, RerankerService],
})
export class SearchModule {}
