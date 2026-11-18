import { ConsoleLogger } from '@nestjs/common';
import * as Sentry from '@sentry/node';

let enabled = false;

/** Turns on error reporting to Sentry (or any Sentry-compatible service) when SENTRY_DSN is set. */
export function initErrorReporting(env: { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string; NODE_ENV: string }) {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    release: process.env.npm_package_version,
    // Errors only, without request bodies, headers, cookies, query strings, user details or local
    // variables. Sentry 11 collects these unless told otherwise (it replaced `sendDefaultPii`).
    dataCollection: {
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, databaseQueryData: false, queues: false,
      stackFrameVariables: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false }, mcp: { inputs: false, outputs: false },
    },
    tracesSampleRate: 0,
  });
  enabled = true;
}

export function reportError(err: unknown, context: Record<string, unknown> = {}) {
  if (enabled) Sentry.captureException(err, { extra: context });
}

/** Nest logger that also reports `logger.error(...)` calls, so failed background jobs are seen too. */
export class ReportingLogger extends ConsoleLogger {
  override error(message: unknown, ...rest: unknown[]) {
    super.error(message, ...rest);
    const err = rest.find((r): r is Error => r instanceof Error) ?? (message instanceof Error ? message : new Error(String(message)));
    reportError(err, { message: message instanceof Error ? message.message : String(message), context: rest.find((r) => typeof r === 'string') });
  }
}
