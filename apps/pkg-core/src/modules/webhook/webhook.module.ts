import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { InteractionModule } from '../interaction/interaction.module';

@Module({
  imports: [InteractionModule],
  controllers: [WebhookController],
})
export class WebhookModule {}
