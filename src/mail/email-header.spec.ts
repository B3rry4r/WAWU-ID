import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MailModule } from './mail.module';
import { MailService } from './mail.service';
import { NOTICE_SAMPLES } from '../testing/notice-samples';
import { parseNotice } from './notice/notice-kinds';
import { noticeContent } from './notice/notice-words';

/**
 * EMAIL-01 round 1: the picture at the top of every mail reads "Who Made This?"
 * (the old one, made for the web, reads "WAWUAfrica"). WAWU ID serves its own,
 * drawn from the app's mark and name at 1200 x 300 (600 px at 2x), and the
 * layout points at it. The web's old picture is left where it is.
 */
const FILE = join(__dirname, 'assets', 'email-header.png');
const NEW_URL = 'https://id.wawuafrica.com/assets/email-header.png';
const OLD_URL = 'https://wawuafrica.com/email-header.png';

/** Width and height from the PNG's own header (IHDR). */
function size(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('the header picture', () => {
  it('is a 1200 x 300 PNG of a sensible size, and not the web image', () => {
    const png = readFileSync(FILE);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(size(png)).toEqual({ width: 1200, height: 300 });
    expect(png.length).toBeGreaterThan(5_000);
    expect(png.length).toBeLessThan(250_000);
    const web = readFileSync(join(__dirname, '..', '..', 'email header.png'));
    expect(png.equals(web)).toBe(false);
  });

  describe('served by WAWU ID', () => {
    let app: INestApplication;
    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          MailModule,
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });
    afterAll(() => app.close());

    const get = (path: string) =>
      request(app.getHttpServer() as Parameters<typeof request>[0]).get(path);

    it('answers GET /assets/email-header.png to anyone, as a picture a mail client may keep', async () => {
      const res = await get('/assets/email-header.png');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('public, max-age=86400');
      expect(Buffer.from(res.body as Buffer).equals(readFileSync(FILE))).toBe(
        true,
      );
    });

    it('serves nothing else under /assets', async () => {
      expect((await get('/assets/other.png')).status).toBe(404);
      expect((await get('/assets/../package.json')).status).toBe(404);
    });
  });
});

describe('the layout points at it', () => {
  const html = (header?: string) => {
    const mail = new MailService({
      get: (k: string) => (k === 'EMAIL_HEADER_URL' ? header : undefined),
    } as never);
    return mail.renderNotice(
      noticeContent(parseNotice('money_in', NOTICE_SAMPLES.money_in)),
      'Ada',
    ).html;
  };

  it("uses WAWU ID's own picture by default, with the app name as its text", () => {
    const out = html();
    expect(out).toContain(`src="${NEW_URL}"`);
    expect(out).toContain('alt="Who Made This?"');
    expect(out).not.toContain(OLD_URL);
  });

  it('keeps EMAIL_HEADER_URL as the override for one environment', () => {
    expect(html('https://cdn.example.test/h.png')).toContain(
      'src="https://cdn.example.test/h.png"',
    );
  });
});
