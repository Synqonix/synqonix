import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { loggablePath, Metrics, writeLog } from './observability.js';

describe('Metrics', () => {
  it('counts by method and status class and renders Prometheus text', () => {
    const m = new Metrics();
    m.record('GET', 200, 10);
    m.record('GET', 204, 30);
    m.record('POST', 503, 5);
    const text = m.render();
    expect(text).toContain('synqonix_http_requests_total{method="GET",status="2xx"} 2');
    expect(text).toContain('synqonix_http_requests_total{method="POST",status="5xx"} 1');
    expect(text).toContain('synqonix_http_request_duration_seconds_count 3');
  });
});

describe('writeLog', () => {
  it('writes one JSON object per line', () => {
    const out = vi.fn();
    writeLog('json', { level: 'info', msg: 'request', status: 200 }, out);
    const line = out.mock.calls[0][0] as string;
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ level: 'info', msg: 'request', status: 200 });
  });
});

describe('AllExceptionsFilter', () => {
  const run = (exception: unknown) => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = { getType: () => 'http', switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ id: 'req-1', method: 'GET', originalUrl: '/x?secret=1' }) }) };
    new AllExceptionsFilter('json', true).catch(exception, host as never);
    return { status, json };
  };

  it('passes HTTP errors through unchanged', () => {
    const { status, json } = run(new HttpException({ statusCode: 409, message: 'taken' }, 409));
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ statusCode: 409, message: 'taken' });
  });

  it('hides the details of unexpected errors but returns the request id', () => {
    const { status, json } = run(new Error('relation "User" does not exist'));
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error', requestId: 'req-1' });
  });
});

describe('loggablePath', () => {
  it('drops the query string and hides invitation tokens', () => {
    expect(loggablePath('/api/v1/invitations/abc123secret/accept?x=1')).toBe('/api/v1/invitations/:token/accept');
    expect(loggablePath('/api/v1/invitations/abc123secret')).toBe('/api/v1/invitations/:token');
    expect(loggablePath('/api/v1/INVITATIONS/abc123secret/accept')).toBe('/api/v1/INVITATIONS/:token/accept');
    expect(loggablePath('/api/v1/tasks?q=1')).toBe('/api/v1/tasks');
  });
});
