/**
 * Whether rate limits are switched off. `THROTTLE_DISABLED=1` exists for test suites that create
 * many accounts quickly; it is ignored in production so a leaked test setting cannot remove the
 * brute-force protection on sign-in.
 */
export const throttleDisabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.THROTTLE_DISABLED === '1' && env.NODE_ENV !== 'production';

/** True when production is configured with THROTTLE_DISABLED=1, which is ignored there (worth a warning). */
export const throttleFlagIgnored = (env: NodeJS.ProcessEnv = process.env) =>
  env.THROTTLE_DISABLED === '1' && env.NODE_ENV === 'production';
