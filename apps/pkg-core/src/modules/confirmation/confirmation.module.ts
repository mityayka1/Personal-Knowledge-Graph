import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingConfirmation } from '@pkg/entities';
import { ConfirmationService } from './confirmation.service';
import { FactSubjectHandler } from './handlers/fact-subject.handler';
import { ResolutionModule } from '../resolution/resolution.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PendingConfirmation]),
    forwardRef(() => ResolutionModule),
  ],
  providers: [ConfirmationService, FactSubjectHandler],
  exports: [ConfirmationService, FactSubjectHandler],
})
export class ConfirmationModule {}
