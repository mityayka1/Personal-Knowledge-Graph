import { Module } from '@nestjs/common';
import { PkgCoreApiService } from './pkg-core-api.service';
import { HealthController } from './health.controller';

@Module({
  providers: [PkgCoreApiService],
  controllers: [HealthController],
  exports: [PkgCoreApiService],
})
export class ApiModule {}
