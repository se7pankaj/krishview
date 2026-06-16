import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import path from 'node:path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Serve the dark dashboard UI from /public/index.html at GET /
  app.useStaticAssets(path.join(__dirname, '..', 'public'));

  // Enable CORS so the dashboard can be opened from any local IP
  app.enableCors();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`KrishView running → http://localhost:${port}`);
  console.log(`Dashboard       → http://localhost:${port}/index.html`);
}
bootstrap();
