import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Job } from '@pkg/entities';
import { JobService } from './job.service';
import { EmbeddingProcessor } from './processors/embedding.processor';
import { EmbeddingModule } from '../embedding/embedding.module';
import { InteractionModule } from '../interaction/interaction.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job]),
    BullModule.registerQueue({ name: 'embedding' }),
    EmbeddingModule,
    forwardRef(() => InteractionModule),
  ],
  providers: [JobService, EmbeddingProcessor],
  exports: [JobService],
})
export class JobModule {}
