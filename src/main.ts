import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
async function bootstrap() {
  for (const name of ['DYNAMODB_TABLE_NAME', 'INBOX_QUEUE_URL', 'OS_QUEUE_URL', 'JWT_SECRET', 'AUTH_CLIENT_LOOKUP_TOKEN']) {
    if (!process.env[name]) throw new Error(`Missing required environment: ${name}`);
  }
  if (process.env.JWT_SECRET!.length < 32 || process.env.AUTH_CLIENT_LOOKUP_TOKEN!.length < 32) throw new Error('Authentication secrets must have at least 32 characters');
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  const config = new DocumentBuilder().setTitle('Oficina Production Service').setVersion('4.0.0').addBearerAuth().addApiKey({type:'apiKey',in:'header',name:'X-Internal-Token'},'internal-token').build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  await app.listen(Number(process.env.PORT || 3002), '0.0.0.0');
}
void bootstrap();
