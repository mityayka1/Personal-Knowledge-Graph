import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingEntityResolution, PendingFact } from '@pkg/entities';
import { PendingResolutionController } from './pending-resolution.controller';
import { PendingResolutionService } from './pending-resolution.service';
import { PendingFactService } from './pending-fact/pending-fact.service';
import { PendingFactController } from './pending-fact/pending-fact.controller';
import { EntityModule } from '../entity/entity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PendingEntityResolution, PendingFact]),
    forwardRef(() => EntityModule),
  ],
  controllers: [PendingResolutionController, PendingFactController],
  providers: [PendingResolutionService, PendingFactService],
  exports: [PendingResolutionService, PendingFactService],
})
export class ResolutionModule {}
