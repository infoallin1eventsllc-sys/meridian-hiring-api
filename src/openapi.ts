import { OpenAPIHono, type z } from '@hono/zod-openapi';
import type { AppEnv } from './context.js';
import { ApiError } from './errors.js';
import { Problem } from './schemas.js';

/** A router whose validation failures become our standard 422 problem. */
export function router() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        const errors = result.error.issues.map((issue) => ({
          path:
            [result.target === 'json' || result.target === 'form' ? '' : `${result.target}.`, issue.path.join('.')]
              .join('')
              .replace(/\.$/, '') || result.target,
          message: issue.message,
        }));
        throw new ApiError('validation_failed', 'Some fields are missing or not valid. See `errors` for details.', {
          errors,
        });
      }
    },
  });
}

export const security = [{ bearerAuth: [] }];

export function json<T extends z.ZodTypeAny>(schema: T, description: string) {
  return { content: { 'application/json': { schema } }, description };
}

export function body<T extends z.ZodTypeAny>(schema: T) {
  return { body: { content: { 'application/json': { schema } }, required: true } };
}

const DESCRIPTIONS: Record<number, string> = {
  400: 'The request body is not valid JSON',
  401: 'Missing, invalid or revoked credentials',
  403: 'The key lacks the scope for this action',
  404: 'Not found in your company',
  409: 'Conflicts with the current state',
  413: 'The upload is too large',
  415: 'The file type is not accepted',
  422: 'Validation failed; see `errors`',
  429: 'Rate limit exceeded; see Retry-After',
};

export function problems(...codes: number[]) {
  return Object.fromEntries(
    [401, 429, ...codes].map((code) => [
      code,
      { content: { 'application/problem+json': { schema: Problem } }, description: DESCRIPTIONS[code] ?? 'Error' },
    ]),
  );
}
