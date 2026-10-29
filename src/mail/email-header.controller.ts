import { Controller, Get, Header, StreamableFile } from '@nestjs/common';
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
@Controller('assets')
export class EmailHeaderController {
  @Get('email-header.png')
  @Header('Cache-Control', 'public, max-age=86400')
  header(): StreamableFile {
    return new StreamableFile(emailHeader(), { type: 'image/png' });
  }
}
