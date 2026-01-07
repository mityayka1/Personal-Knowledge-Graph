import { Controller, Get } from '@nestjs/common';
import { PkgCoreApiService } from './pkg-core-api.service';

@Controller('health')
export class HealthController {
  constructor(private pkgCoreApi: PkgCoreApiService) {}

  @Get()
  async check() {
    let pkgCoreStatus = 'disconnected';

    try {
      const health = await this.pkgCoreApi.checkHealth();
      pkgCoreStatus = health.status === 'ok' ? 'connected' : 'error';
    } catch {
      pkgCoreStatus = 'disconnected';
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        telegram: 'running', // Would check actual connection status
        pkg_core: pkgCoreStatus,
      },
    };
  }
}
