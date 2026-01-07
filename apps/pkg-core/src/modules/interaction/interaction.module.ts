import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Interaction,
  InteractionParticipant,
  Message,
  TranscriptSegment,
  InteractionSummary,
} from '@pkg/entities';
import { InteractionController } from './interaction.controller';
import { InteractionService } from './interaction.service';
import { MessageController } from './message/message.controller';
import { MessageService } from './message/message.service';
import { TranscriptSegmentService } from './transcript-segment/transcript-segment.service';
import { TranscriptSegmentController } from './transcript-segment/transcript-segment.controller';
import { InteractionSummaryService } from './interaction-summary/interaction-summary.service';
import { EntityModule } from '../entity/entity.module';
import { ResolutionModule } from '../resolution/resolution.module';
import { JobModule } from '../job/job.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Interaction,
      InteractionParticipant,
      Message,
      TranscriptSegment,
      InteractionSummary,
    ]),
    EntityModule,
    forwardRef(() => ResolutionModule),
    forwardRef(() => JobModule),
  ],
  controllers: [InteractionController, MessageController, TranscriptSegmentController],
  providers: [
    InteractionService,
    MessageService,
    TranscriptSegmentService,
    InteractionSummaryService,
  ],
  exports: [InteractionService, MessageService, TranscriptSegmentService, InteractionSummaryService],
})
export class InteractionModule {}
