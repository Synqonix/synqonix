import { describe, expect, it } from 'vitest';
import { throttleDisabled, throttleFlagIgnored } from './throttle.js';

describe('throttleDisabled', () => {
  it('switches rate limits off for tests and development only', () => {
    expect(throttleDisabled({ THROTTLE_DISABLED: '1', NODE_ENV: 'test' })).toBe(true);
    expect(throttleDisabled({ THROTTLE_DISABLED: '1', NODE_ENV: 'development' })).toBe(true);
    expect(throttleDisabled({ THROTTLE_DISABLED: '1' })).toBe(true);
    expect(throttleDisabled({ THROTTLE_DISABLED: '0', NODE_ENV: 'test' })).toBe(false);
    expect(throttleDisabled({ NODE_ENV: 'development' })).toBe(false);
  });

  it('never switches them off in production', () => {
    expect(throttleDisabled({ THROTTLE_DISABLED: '1', NODE_ENV: 'production' })).toBe(false);
    expect(throttleFlagIgnored({ THROTTLE_DISABLED: '1', NODE_ENV: 'production' })).toBe(true);
    expect(throttleFlagIgnored({ THROTTLE_DISABLED: '1', NODE_ENV: 'test' })).toBe(false);
  });
});
