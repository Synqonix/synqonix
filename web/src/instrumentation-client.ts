// Runs before the app becomes interactive (Next.js `instrumentation-client` convention).
// Error reporting is opt-in: nothing loads or is sent unless NEXT_PUBLIC_SENTRY_DSN is set at build time.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  void import("@sentry/browser")
    .then((Sentry) =>
      Sentry.init({
        dsn,
        environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
        // Errors only, without cookies or user details.
        sendDefaultPii: false,
        tracesSampleRate: 0,
      }),
    )
    .catch(() => {
      /* monitoring must never break the app */
    });
}
