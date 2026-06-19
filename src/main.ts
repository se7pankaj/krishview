import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { LoggingInterceptor } from './common/logging.interceptor';
import path from 'node:path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Use NestJS built-in logger — shows timestamp + context label on every line
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const logger = new Logger('Bootstrap');

  // ── Global interceptor — logs every HTTP request/response ─────────────────
  app.useGlobalInterceptors(new LoggingInterceptor());

  // ── Serve dashboard UI from /public/index.html at GET / ──────────────────
  app.useStaticAssets(path.join(__dirname, '..', 'public'));

  // ── CORS — allow dashboard to be opened from any IP (mobile, remote) ─────
  app.enableCors();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`════════════════════════════════════════════`);
  logger.log(`  KrishView API  →  http://localhost:${port}`);
  logger.log(`  Dashboard      →  http://localhost:${port}/index.html`);
  logger.log(`  Debug endpoint →  http://localhost:${port}/dashboard/debug`);
  logger.log(`════════════════════════════════════════════`);
}

bootstrap().catch(err => {
  // If bootstrap itself throws, print it clearly before process exits
  console.error('[KrishView] FATAL bootstrap error:', err);
  process.exit(1);
});
