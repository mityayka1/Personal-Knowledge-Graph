import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [
    ConfigModule,
    HttpModule.register({
      timeout: 120000, // 2 minutes for large media files
      maxContentLength: 100 * 1024 * 1024, // 100MB max
      maxBodyLength: 100 * 1024 * 1024,
    }),
  ],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
