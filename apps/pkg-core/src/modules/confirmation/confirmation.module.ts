import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingConfirmation, ExtractedEvent } from '@pkg/entities';
import { ConfirmationService } from './confirmation.service';
import { FactSubjectHandler } from './handlers/fact-subject.handler';
import { ResolutionModule } from '../resolution/resolution.module';
import { EntityModule } from '../entity/entity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PendingConfirmation, ExtractedEvent]),
    forwardRef(() => ResolutionModule),
    forwardRef(() => EntityModule),
  ],
  providers: [ConfirmationService, FactSubjectHandler],
  exports: [ConfirmationService, FactSubjectHandler],
})
export class ConfirmationModule {}
