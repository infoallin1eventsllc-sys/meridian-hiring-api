import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script without type declarations
import { BOTID_OUT, bundleBotId } from '../scripts/build-botid.mjs';

describe('committed browser assets', () => {
  it('public/botid.js matches a fresh build of the BotID script', async () => {
    expect(readFileSync(BOTID_OUT, 'utf8'), 'run npm run build:botid and commit the result').toBe(await bundleBotId());
  });
});
