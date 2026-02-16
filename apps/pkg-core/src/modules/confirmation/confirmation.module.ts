import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingConfirmation, ExtractedEvent, EntityFact } from '@pkg/entities';
import { ConfirmationService } from './confirmation.service';
import { FactSubjectHandler } from './handlers/fact-subject.handler';
import { FactValueHandler } from './handlers/fact-value.handler';
import { IdentifierAttributionHandler } from './handlers/identifier-attribution.handler';
import { EntityMergeHandler } from './handlers/entity-merge.handler';
import { ResolutionModule } from '../resolution/resolution.module';
import { EntityModule } from '../entity/entity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PendingConfirmation, ExtractedEvent, EntityFact]),
    forwardRef(() => ResolutionModule),
    forwardRef(() => EntityModule),
  ],
  providers: [
    ConfirmationService,
    FactSubjectHandler,
    FactValueHandler,
    IdentifierAttributionHandler,
    EntityMergeHandler,
  ],
  exports: [
    ConfirmationService,
    FactSubjectHandler,
    FactValueHandler,
    IdentifierAttributionHandler,
    EntityMergeHandler,
  ],
})
export class ConfirmationModule {}
