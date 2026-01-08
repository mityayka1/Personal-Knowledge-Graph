import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message, TranscriptSegment, InteractionSummary } from '@pkg/entities';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { FtsService } from './fts.service';
import { VectorService } from './vector.service';
import { EmbeddingModule } from '../embedding/embedding.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message, TranscriptSegment, InteractionSummary]),
    EmbeddingModule,
  ],
  controllers: [SearchController],
  providers: [SearchService, FtsService, VectorService],
  exports: [SearchService],
})
export class SearchModule {}
