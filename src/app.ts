import { timingSafeEqual } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { authenticate } from './auth.js';
import type { AppEnv, Deps } from './context.js';
import { ApiError, fromPostgres, problem } from './errors.js';
import { runMaintenance } from './maintenance.js';
import { account } from './routes/account.js';
import { applications } from './routes/applications.js';
import { candidates } from './routes/candidates.js';
import { jobs } from './routes/jobs.js';
import { resumes } from './routes/resumes.js';
import { demoInbox, sandbox } from './routes/sandbox.js';
import { webhooks } from './routes/webhooks.js';
import { processDueDeliveries } from './webhooks.js';

export const API_VERSION = '1.0.0';

// The docs viewer, pinned to one version on jsDelivr. The integrity hash makes the
// browser refuse the file if a single byte differs. (Vercel doesn't publish files
// that a build step writes into public/, so it can't be self-hosted from there.)
const SCALAR = {
  src: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.74.0/dist/browser/standalone.js',
  integrity: 'sha384-VXnKAz61Xwc3tbw1P+KKrUP7YbcsSl1Ik4is5UnogJyw9XEYZ5Ay/T1i0zPYtSZH',
};

const DOCS_INTRO = `
A hiring pipeline API for recruiting teams. Companies post **jobs**, **candidates** apply and upload a **résumé**,
and each **application** moves through *Applied → Screen → Interview → Offer → Hired / Rejected*. Every move is
saved to a stage history and sent to your **webhooks**.

## Try it in two steps

1. Open the [pipeline board](/) and press **Open a demo board**. You get a private demo company full of sample
   data. (On the live demo, sandboxes can only be created from a browser, so the board does it for you.)
2. Come back here: its key is already filled in under **Authentication**, so every endpoint can be called with
   *Test Request*. Running locally, **Sandbox → Create a sandbox** below works too.

## Basics

- **Auth:** \`Authorization: Bearer mh_live_…\` (an API key), or a Supabase login token for dashboard users.
  Keys have scopes: \`read\`, \`write\`, \`admin\`.
- **Isolation:** each company only ever sees its own data. This is enforced by Postgres row-level security,
  not just by application code.
- **Lists** are newest first. Pass \`next_cursor\` back as \`?cursor=\` for the next page.
- **Rate limits** are per company, per minute; every response carries \`RateLimit-Limit\`, \`RateLimit-Remaining\`
  and \`RateLimit-Reset\` headers.

## Errors

Every error has the same shape, with \`Content-Type: application/problem+json\`:

\`\`\`json
{ "type": "…/docs#errors-validation_failed", "title": "Validation failed", "status": 422,
  "code": "validation_failed", "detail": "Some fields are missing or not valid. See \`errors\` for details.",
  "request_id": "req_…", "errors": [{ "path": "email", "message": "Invalid email address" }] }
\`\`\`

| code | status | meaning |
|---|---|---|
| \`invalid_json\` | 400 | The body is not valid JSON |
| \`unauthorized\` | 401 | Missing, invalid, revoked or expired credentials |
| \`forbidden\` | 403 | The key lacks the scope for this action |
| \`not_found\` | 404 | Nothing with that id in your company |
| \`conflict\` | 409 | Clashes with existing data, e.g. a duplicate email |
| \`invalid_transition\` | 409 | That stage change isn't allowed; \`allowed\` lists the options |
| \`payload_too_large\` | 413 | The upload is too big |
| \`unsupported_media_type\` | 415 | The file isn't a PDF or Word document |
| \`validation_failed\` | 422 | Fields are missing or wrong; see \`errors\` |
| \`rate_limited\` | 429 | Too many requests; wait \`Retry-After\` seconds |

## Webhooks

Each event is a POST with a JSON body and these headers: \`Meridian-Event\`, \`Meridian-Event-Id\`,
\`Meridian-Delivery\` and \`Meridian-Signature: t=<unix time>,v1=<hex>\`, where \`v1\` is
HMAC-SHA256 of \`"<t>.<raw body>"\` with your endpoint's secret. Reject events whose \`t\` is more than five
minutes old. Answer with any 2xx within 8 seconds; otherwise we retry after 1 min, 5 min, 30 min, 2 h and 12 h.
`;

function docsPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meridian Interface Hire · API docs</title>
  <meta name="description" content="Interactive reference for the Meridian Hire hiring pipeline API, by Meridian Interface.">
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
</head>
<body>
  <div id="app"></div>
  <script src="${SCALAR.src}" integrity="${SCALAR.integrity}" crossorigin="anonymous"></script>
  <script src="/docs-init.js"></script>
</body>
</html>`;
}

function secretMatches(given: string | undefined, expected: string | undefined) {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * On Supabase the cron secret is generated inside the database (see
 * db/supabase/setup.sql) and read from Vault here, so no person ever has to
 * copy it between systems.
 */
async function vaultSecretMatches(deps: Deps, token: string | undefined) {
  if (!token) return false;
  try {
    const [row] = await deps.sql<{ secret: string }[]>`
      select decrypted_secret as secret from vault.decrypted_secrets where name = 'hire_cron_secret'`;
    return secretMatches(token, row?.secret);
  } catch {
    return false; // no Vault (plain Postgres)
  }
}

export function createApp(deps: Deps) {
  const app = new OpenAPIHono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('requestId', `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`);
    c.header('Request-Id', c.get('requestId'));
    await next();
  });
  app.use(
    '*',
    // The same values as the static files get from vercel.json, except style-src:
    // the docs viewer (Scalar) sets inline styles, so only these responses allow them.
    secureHeaders({
      strictTransportSecurity: 'max-age=63072000; includeSubDomains',
      referrerPolicy: 'strict-origin-when-cross-origin',
      xFrameOptions: 'DENY',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // API keys travel in a header (never cookies), so any site may call the API.
  app.use(
    '/v1/*',
    cors({
      origin: '*',
      allowHeaders: ['Authorization', 'Content-Type', 'Meridian-Company'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use('/v1/*', async (c, next) => {
    // Uploads have their own, larger limit on the résumé route.
    if (c.req.method === 'POST' && /^\/v1\/candidates\/[^/]+\/resumes$/.test(c.req.path)) return next();
    return bodyLimit({
      maxSize: 1024 * 1024,
      onError: () => {
        throw new ApiError('payload_too_large', 'Request bodies can be up to 1 MB.');
      },
    })(c, next);
  });
  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || (c.req.path === '/v1/sandbox' && c.req.method === 'POST')) return next();
    return authenticate(c, next);
  });

  for (const r of [sandbox, account, jobs, candidates, applications, resumes, webhooks]) app.route('/v1', r);
  app.route('/', demoInbox);

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'An API key (mh_live_… or mh_sandbox_…) or a Supabase login token.',
  });
  app.doc31('/openapi.json', (c) => ({
    openapi: '3.1.0',
    info: {
      title: 'Meridian Hire API',
      version: API_VERSION,
      description: DOCS_INTRO,
      contact: { name: 'Meridian Interface', url: 'https://meridianinterface.com' },
    },
    servers: [{ url: new URL(c.req.url).origin }],
    tags: [
      { name: 'Sandbox', description: 'Start here: get a demo company and key in one call.' },
      { name: 'Account' },
      { name: 'Jobs' },
      { name: 'Candidates' },
      { name: 'Applications', description: 'Applications and how they move through the pipeline.' },
      { name: 'Résumés' },
      { name: 'Webhooks' },
      { name: 'API keys' },
      { name: 'Audit log' },
    ],
  }));

  app.get('/docs', (c) => c.html(docsPage()));

  // On Vercel this function answers "/" before the static files in public/ are
  // consulted, so send visitors to the board explicitly.
  app.get('/', (c) => c.redirect('/index.html', 302));

  app.get('/health', async (c) => {
    try {
      await deps.sql`select 1`;
      return c.json({ status: 'ok', version: API_VERSION });
    } catch {
      return c.json({ status: 'degraded', version: API_VERSION }, 503);
    }
  });

  // Called every minute by Vercel Cron (vercel.json sends CRON_SECRET as the bearer token),
  // or by Supabase pg_cron on hosts without Vercel Cron (db/supabase/setup.sql).
  app.on(['GET', 'POST'], '/internal/tick', async (c) => {
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (!secretMatches(token, deps.config.cronSecret) && !(await vaultSecretMatches(deps, token))) {
      throw new ApiError('unauthorized', 'Bad cron secret.');
    }
    const webhooks = await processDueDeliveries(deps, { limit: 100 });
    const maintenance = await runMaintenance(deps);
    return c.json({ webhooks, maintenance });
  });

  app.notFound((c) => {
    const err = new ApiError('not_found', `No endpoint at ${c.req.method} ${c.req.path}. See /docs.`);
    return c.json(problem(err, c.get('requestId') ?? 'req_unknown', deps.config.publicBaseUrl), 404, {
      'Content-Type': 'application/problem+json',
    });
  });

  app.onError((err, c) => {
    let apiError: ApiError;
    if (err instanceof ApiError) apiError = err;
    else if (err instanceof HTTPException && err.status === 400) {
      apiError = new ApiError('invalid_json', 'The request body could not be parsed. Send valid JSON.');
    } else {
      apiError =
        fromPostgres(err) ?? new ApiError('internal_error', 'Something went wrong on our side. It has been logged.');
    }
    if (apiError.code === 'internal_error') console.error(c.get('requestId'), err);
    const extraHeaders: Record<string, string> = { 'Content-Type': 'application/problem+json' };
    if (apiError.code === 'rate_limited' && typeof apiError.extra.retry_after === 'number') {
      extraHeaders['Retry-After'] = String(apiError.extra.retry_after);
    }
    return c.json(
      problem(apiError, c.get('requestId') ?? 'req_unknown', deps.config.publicBaseUrl),
      apiError.status as 400,
      extraHeaders,
    );
  });

  return app;
}
