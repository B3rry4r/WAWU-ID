import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildContract, contractText } from './build-contract';

/**
 * Writes contract/openapi.json from the code. Run with `npm run
 * contract:build` from the repo root (the path is the working directory's,
 * not this file's, which sits in dist/ once built).
 */
async function emit(): Promise<void> {
  const document = await buildContract();
  const out = resolve(process.cwd(), 'contract/openapi.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, contractText(document), 'utf8');
  console.log(
    `openapi.json written: ${Object.keys(document.paths).length} paths, ${
      Object.keys(document.components?.schemas ?? {}).length
    } schemas -> ${out}`,
  );
}

void emit();
