import { Module } from '@nestjs/common';
import { FactExtractionService } from './fact-extraction.service';
import { ExtractionController } from './extraction.controller';
import { ResolutionModule } from '../resolution/resolution.module';

@Module({
  imports: [ResolutionModule],
  controllers: [ExtractionController],
  providers: [FactExtractionService],
  exports: [FactExtractionService],
})
export class ExtractionModule {}
