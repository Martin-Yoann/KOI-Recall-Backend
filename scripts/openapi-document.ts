import { stringify } from 'yaml';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { buildOpenApiConfig } from '../src/contracts/toc.js';

export function renderOpenApiYaml() {
  const config = loadConfig({
    APP_ENV: 'local',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  });
  const app = createApp({ config });
  const document = app.getOpenAPIDocument(buildOpenApiConfig(config.PROBLEM_BASE_URL));

  return `${stringify(document, { lineWidth: 0, sortMapEntries: true })}`;
}
