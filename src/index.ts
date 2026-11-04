// Vercel entry point. Vercel only treats this file as the app if it imports `hono`
// itself, so the import below is load-bearing, not just a type check.
// Files in public/ (the pipeline board) are served by Vercel's CDN.
import { waitUntil } from '@vercel/functions';
import { Hono } from 'hono';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { buildDeps } from './deps.js';

const app = createApp(buildDeps(loadConfig(), (task) => waitUntil(task)));
if (!(app instanceof Hono)) throw new Error('createApp must return a Hono app');

export default app;
