import { NestFactory } from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { AppModule } from '../app.module';

/** The tag that puts a route in the published contract. */
export const APP_TAG = 'app';

/**
 * wawu-id's published contract (contract/openapi.json, AUTH-05, G-5): every
 * route the mobile app calls, with its request and answer bodies, so the app
 * generates its types (`npm run api` in the mobile repo) instead of reading
 * answers by hand. A route is in it when its handler carries the `app` tag;
 * the web's and the services' routes are described in
 * WAWUAfrica_API_Contracts.md.
 *
 * Built from the route and DTO metadata only: preview mode builds the module
 * graph without making providers, so no database or key is needed.
 */
export async function buildContract(): Promise<OpenAPIObject> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });
  const config = new DocumentBuilder()
    .setTitle('WAWU ID')
    .setDescription(
      [
        'The sign-in service: the routes the mobile app calls.',
        '',
        'Every success body is `{ data: ... }`, exactly as described here (no',
        'interceptor). Every error body is ErrorBody. Generated from the code by',
        '`npm run contract:build`; never edited by hand.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'wawu-id',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  await app.close();
  return onlyAppRoutes(document);
}

/** Drop every operation without the app tag, then every schema nothing left refers to. */
function onlyAppRoutes(document: OpenAPIObject): OpenAPIObject {
  for (const [path, item] of Object.entries(document.paths)) {
    const ops = item as Record<string, { tags?: string[] }>;
    for (const method of Object.keys(ops)) {
      if (!ops[method]?.tags?.includes(APP_TAG)) delete ops[method];
    }
    if (Object.keys(ops).length === 0) delete document.paths[path];
  }

  const schemas = document.components?.schemas ?? {};
  const used = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = value.replace('#/components/schemas/', '');
        if (!used.has(name)) {
          used.add(name);
          visit(schemas[name]);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(document.paths);
  for (const name of Object.keys(schemas)) {
    if (!used.has(name)) delete schemas[name];
  }
  document.tags = [];
  return document;
}

/** The file's exact text, so the build and the drift check write the same bytes. */
export function contractText(document: OpenAPIObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
