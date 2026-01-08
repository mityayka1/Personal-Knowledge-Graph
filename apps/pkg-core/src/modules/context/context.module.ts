import { Module } from '@nestjs/common';
import { ContextController } from './context.controller';
import { ContextService } from './context.service';
import { EntityModule } from '../entity/entity.module';
import { InteractionModule } from '../interaction/interaction.module';

@Module({
  imports: [EntityModule, InteractionModule],
  controllers: [ContextController],
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
