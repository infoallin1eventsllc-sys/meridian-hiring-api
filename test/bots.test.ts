import { afterEach, describe, expect, it, vi } from 'vitest';

// BotID only gives real verdicts on Vercel, so the server half is replaced here.
const verdict = vi.hoisted(() => ({ isBot: false }));
vi.mock('botid/server', () => ({
  checkBotId: vi.fn(async () => ({
    isBot: verdict.isBot,
    isHuman: !verdict.isBot,
    isVerifiedBot: false,
    bypassed: false,
  })),
}));

const { makeApp } = await import('./helpers.js');

const ip = () => ({ 'X-Real-IP': `192.0.2.${Math.floor(Math.random() * 250)}` });

describe('bot protection on sandbox creation', () => {
  afterEach(() => {
    delete process.env.VERCEL;
    verdict.isBot = false;
  });

  it('refuses scripts on Vercel before spending any rate-limit allowance', async () => {
    process.env.VERCEL = '1';
    verdict.isBot = true;
    const t = makeApp();
    const res = await t.request('POST', '/v1/sandbox', { headers: ip() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.detail).toMatch(/browser/);
    expect(res.headers.get('ratelimit-limit')).toBeNull();
  });

  it('lets a real browser through on Vercel', async () => {
    process.env.VERCEL = '1';
    const t = makeApp();
    expect((await t.request('POST', '/v1/sandbox', { headers: ip() })).status).toBe(201);
  });

  it('skips the check off Vercel, where BotID has no proxy', async () => {
    verdict.isBot = true;
    const t = makeApp();
    expect((await t.request('POST', '/v1/sandbox', { headers: ip() })).status).toBe(201);
  });
});
