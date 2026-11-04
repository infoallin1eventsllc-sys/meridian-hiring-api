import { checkBotId } from 'botid/server';
import type { Ctx } from './context.js';

/**
 * True when Vercel BotID says a request came from a script rather than a real
 * browser. The board loads BotID's browser script (public/botid.js) for
 * the protected paths; anything without its proof is classified as a bot.
 *
 * Only runs on Vercel, where BotID's proxy paths exist (vercel.json). Locally and
 * in tests it always answers false. If BotID itself errors, the request goes
 * through and the usual rate limits still apply: a bot check that fails closed
 * would take the demo down with it.
 */
export async function isBotRequest(c: Ctx): Promise<boolean> {
  if (!process.env.VERCEL) return false;
  try {
    const verdict = await checkBotId({ advancedOptions: { headers: c.req.header() } });
    return verdict.isBot && !verdict.isVerifiedBot;
  } catch (err) {
    console.warn('BotID check failed; allowing the request', err);
    return false;
  }
}
