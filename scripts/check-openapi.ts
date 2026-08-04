import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { renderOpenApiYaml } from './openapi-document.js';

const outputPath = resolve('openapi/toc-v1.openapi.yaml');
const committed = await readFile(outputPath, 'utf8');
const generated = renderOpenApiYaml();

if (committed !== generated) {
  throw new Error('OpenAPI drift detected. Run pnpm openapi:generate and commit the result.');
}

console.log('OpenAPI contract is up to date.');
