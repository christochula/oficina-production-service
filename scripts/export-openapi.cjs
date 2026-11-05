require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { AppModule } = require('../dist/app.module');
const fs = require('node:fs');
(async () => {
  process.env.WORKER_ENABLED = 'false';
  const app = await NestFactory.create(AppModule, { logger: false });
  const config = new DocumentBuilder().setTitle('Oficina Production Service').setVersion('4.0.0').addBearerAuth().addApiKey({ type: 'apiKey', in: 'header', name: 'X-Internal-Token' }, 'internal-token').build();
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/openapi.json', JSON.stringify(SwaggerModule.createDocument(app, config), null, 2) + '\n');
  await app.close();
})().catch(error => { console.error(error.message); process.exitCode = 1; });
