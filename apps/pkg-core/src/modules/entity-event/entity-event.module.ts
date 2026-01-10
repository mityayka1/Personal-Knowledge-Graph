import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityEvent } from '@pkg/entities';
import { EntityEventService } from './entity-event.service';
import { EntityEventController } from './entity-event.controller';

@Module({
  imports: [TypeOrmModule.forFeature([EntityEvent])],
  controllers: [EntityEventController],
  providers: [EntityEventService],
  exports: [EntityEventService],
})
export class EntityEventModule {}
