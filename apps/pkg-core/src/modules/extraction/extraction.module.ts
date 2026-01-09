import { Module, forwardRef } from '@nestjs/common';
import { FactExtractionService } from './fact-extraction.service';
import { ExtractionController } from './extraction.controller';
import { ResolutionModule } from '../resolution/resolution.module';
import { InteractionModule } from '../interaction/interaction.module';
import { EntityModule } from '../entity/entity.module';

@Module({
  imports: [
    ResolutionModule,
    forwardRef(() => InteractionModule),
    forwardRef(() => EntityModule),
  ],
  controllers: [ExtractionController],
  providers: [FactExtractionService],
  exports: [FactExtractionService],
})
export class ExtractionModule {}
