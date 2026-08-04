import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { renderOpenApiYaml } from './openapi-document.js';

const outputPath = resolve('openapi/toc-v1.openapi.yaml');

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderOpenApiYaml(), 'utf8');

console.log(`Generated ${outputPath}`);
