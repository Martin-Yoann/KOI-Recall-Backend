import { stringify } from 'yaml';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { openApiConfig } from '../src/contracts/toc.js';

export function renderOpenApiYaml() {
  const app = createApp({
    config: loadConfig({
      APP_ENV: 'local',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    }),
  });
  const document = app.getOpenAPIDocument(openApiConfig);

  return `${stringify(document, { lineWidth: 0, sortMapEntries: true })}`;
}
