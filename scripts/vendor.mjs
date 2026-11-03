// Copies the pinned API-docs viewer from node_modules into public/vendor, so the
// docs page loads it from this site (CSP script-src 'self'). Runs before dev and
// on every Vercel build. The hash must match SCALAR.integrity in src/app.ts.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const EXPECTED = 'sha384-VXnKAz61Xwc3tbw1P+KKrUP7YbcsSl1Ik4is5UnogJyw9XEYZ5Ay/T1i0zPYtSZH';
const source = new URL('../node_modules/@scalar/api-reference/dist/browser/standalone.js', import.meta.url);
const target = new URL('../public/vendor/scalar-api-reference-1.74.0.js', import.meta.url);

const body = readFileSync(source);
const actual = `sha384-${createHash('sha384').update(body).digest('base64')}`;
if (actual !== EXPECTED) {
  console.error(`Docs viewer hash changed (${actual}). Update EXPECTED here and SCALAR in src/app.ts.`);
  process.exit(1);
}
mkdirSync(new URL('.', target), { recursive: true });
writeFileSync(target, body);
console.log('Copied docs viewer to public/vendor');
