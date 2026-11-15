import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import cors from "@fastify/cors";
import { AppModule } from "./app.module.js";
import { MAX_BUNDLE_BYTES } from "./projects/bundle.service.js";

const DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // A comma separated allowlist, so the rig can be reached at localhost, at
  // 127.0.0.1, and at the machine's LAN address without a rebuild. Still a
  // strict list: reflecting the request origin would let any page the browser
  // visits rewrite a live audio chain, since nothing here is authenticated.
  const origins = (process.env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGINS)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  // methods must list PUT explicitly. The plugin defaults to GET,HEAD,POST, so
  // without this the browser preflight for PUT /devices/chain is answered with
  // an allow-methods that omits PUT, and Firefox rejects the whole request as
  // a network error before the body is ever sent. A GET-only chain load
  // appears to work, which hides it. PATCH and DELETE cover project rename and
  // delete.
  await app.register(cors, {
    origin: origins,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // useBodyParser marks parser registration as complete, which would skip the
  // adapter's own JSON and urlencoded parsers during init(). Register those
  // first, then add the ZIP parser, so existing endpoints keep parsing JSON.
  app.getHttpAdapter().registerParserMiddleware();
  app.useBodyParser("application/zip", { bodyLimit: MAX_BUNDLE_BYTES });

  await app.listen({
    port: Number(process.env.PORT ?? 3001),
    host: "0.0.0.0",
  });
}

bootstrap();
