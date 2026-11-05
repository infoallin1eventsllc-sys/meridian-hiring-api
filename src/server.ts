// Local development server: npm run dev
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { buildDeps } from './deps.js';
import { MemoryStorage } from './storage.js';

const config = loadConfig();
const deps = buildDeps(config, (task) => void task);
const app = createApp(deps);
// Without Supabase, résumés live in memory; this serves the short-lived links MemoryStorage hands out.
if (deps.storage instanceof MemoryStorage) {
  const files = deps.storage.files;
  app.get('/_local-storage/:path', (c) => {
    const file = files.get(c.req.param('path'));
    const expires = Number(c.req.query('expires'));
    if (!file || !(expires * 1000 > Date.now())) return c.text('This link has expired or the file is gone.', 404);
    return c.body(new Uint8Array(file.body), 200, {
      'Content-Type': file.contentType,
      'Cache-Control': 'private, no-store',
    });
  });
}
app.use('/*', serveStatic({ root: './public' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Meridian Hire running at http://localhost:${port}  (docs: /docs)`);
});
