// Local development server: npm run dev
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { buildDeps } from './deps.js';

const config = loadConfig();
const app = createApp(buildDeps(config, (task) => void task));
app.use('/*', serveStatic({ root: './public' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Meridian Hire running at http://localhost:${port}  (docs: /docs)`);
});
