// Bundles Vercel BotID's browser script into public/botid.js. The output is
// committed, because Vercel publishes public/ as it is in git: files a build step
// writes there are not served. test/assets.test.ts fails if the committed copy
// differs from a fresh build, so run `npm run build:botid` after upgrading botid.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const BOTID_OUT = fileURLToPath(new URL('../public/botid.js', import.meta.url));

export async function bundleBotId() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./botid-client.mjs', import.meta.url))],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    define: { 'process.env.NODE_ENV': '"production"' },
    write: false,
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(BOTID_OUT, await bundleBotId());
  console.log('Bundled BotID to public/botid.js');
}
