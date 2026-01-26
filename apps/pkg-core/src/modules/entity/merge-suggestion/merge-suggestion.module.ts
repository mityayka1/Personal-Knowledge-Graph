import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  EntityRecord,
  EntityIdentifier,
  EntityFact,
  DismissedMergeSuggestion,
} from '@pkg/entities';
import { MergeSuggestionService } from './merge-suggestion.service';
import { MergeSuggestionController } from './merge-suggestion.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EntityRecord,
      EntityIdentifier,
      EntityFact,
      DismissedMergeSuggestion,
    ]),
  ],
  controllers: [MergeSuggestionController],
  providers: [MergeSuggestionService],
  exports: [MergeSuggestionService],
})
export class MergeSuggestionModule {}
