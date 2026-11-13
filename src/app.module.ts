import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Store } from './model';
import { DynamoStore } from './dynamo.store';
import { ProductionService } from './production.service';
import { InternalController, ProductionController } from './production.controller';
import { InternalGuard, JwtGuard } from './auth';
import { Messaging } from './messaging';
import { HealthController } from './health.controller';
import { InternalInventoryController, InventoryController, InventoryService } from './inventory';
import { Metrics, MetricsInterceptor } from './metrics';
@Module({
  controllers: [ProductionController, InternalController, HealthController, InventoryController, InternalInventoryController],
  providers: [{ provide: Store, useClass: DynamoStore }, ProductionService, InventoryService, JwtGuard, InternalGuard, Messaging,Metrics,{provide:APP_INTERCEPTOR,useClass:MetricsInterceptor}],
})
export class AppModule {}
