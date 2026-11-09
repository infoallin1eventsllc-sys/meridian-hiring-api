// Browser entry for Vercel BotID, bundled to public/botid.js by build-botid.mjs.
// It wraps fetch so requests to the paths below carry BotID's proof that a real
// browser sent them; src/bots.ts checks that proof on the server.
import { initBotId } from 'botid/client/core';

// BotID's proxy only exists on Vercel (vercel.json rewrites), so local runs skip it.
if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  initBotId({
    protect: [
      { path: '/v1/sandbox', method: 'POST' },
      { path: '/v1/public/jobs/*/applications', method: 'POST' },
    ],
  });
}
