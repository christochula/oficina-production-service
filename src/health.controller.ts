import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Store } from './model';
@Controller(['api/health', 'api/v1/production/health'])
export class HealthController {
  constructor(private readonly store: Store) {}
  @Get() health() { return this.ready(); }
  @Get('live') live() { return { status: 'ok', service: 'oficina-production-service' }; }
  @Get('ready') async ready() {
    try { await this.store.exists('HEALTHCHECK'); return { status: 'ok' }; }
    catch { throw new ServiceUnavailableException('DynamoDB unavailable'); }
  }
}
