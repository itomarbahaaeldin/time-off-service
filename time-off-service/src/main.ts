import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // swagger setup
  const config = new DocumentBuilder()
    .setTitle('Time-Off Service')
    .setDescription('API for managing employee time-off requests and HCM balance sync')
    .setVersion('1.0')
    .addTag('balances')
    .addTag('time-off-requests')
    .build();

  const doc = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, doc);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`App running on port ${port}`);
}
bootstrap();
