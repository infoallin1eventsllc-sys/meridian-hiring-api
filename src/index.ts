// Vercel entry point: Vercel detects a Hono app exported from src/index.ts.
// Files in public/ (the pipeline board) are served by Vercel's CDN.
import { waitUntil } from '@vercel/functions';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { buildDeps } from './deps.js';

const app = createApp(buildDeps(loadConfig(), (task) => waitUntil(task)));

export default app;
