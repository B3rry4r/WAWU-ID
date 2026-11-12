import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  StreamableFile,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read once, on the first request: the picture is part of the build. */
let picture: Buffer | undefined;
function emailHeader(): Buffer {
  picture ??= readFileSync(join(__dirname, 'assets', 'email-header.png'));
  return picture;
}

/**
 * The picture at the top of every email (EMAIL-01 round 1), served by WAWU ID
 * itself so it reads "Who Made This?" and does not depend on the web app's old
 * one. Public by design: a mail client fetches it with no session. It serves
 * this one file and nothing else under /assets. The file is copied into the
 * build by `assets` in nest-cli.json.
 */
const VOICES_LOGOS: ReadonlySet<string> = new Set([
  'logo-wordmark-white.png',
  'logo-wordmark-green.png',
  'logo-icon-white.png',
  'logo-icon-green.png',
]);
const voicesPictures = new Map<string, Buffer>();

@Controller('assets')
export class EmailHeaderController {
  @Get('email-header.png')
  @Header('Cache-Control', 'public, max-age=86400')
  header(): StreamableFile {
    return new StreamableFile(emailHeader(), { type: 'image/png' });
  }

  /**
   * The VOICES logos the VOICES mails show (VOICES-MAIL, V-44), served the way
   * the header picture is. Only these four files; any other name is a 404.
   */
  @Get('voices/:file')
  @Header('Cache-Control', 'public, max-age=86400')
  voicesLogo(@Param('file') file: string): StreamableFile {
    if (!VOICES_LOGOS.has(file)) throw new NotFoundException();
    let picture = voicesPictures.get(file);
    if (!picture) {
      picture = readFileSync(join(__dirname, 'assets', 'voices', file));
      voicesPictures.set(file, picture);
    }
    return new StreamableFile(picture, { type: 'image/png' });
  }
}
