import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { reportError } from './error-reporting.js';
import { loggablePath, writeLog } from './observability.js';

/**
 * Leaves HTTP errors as they are; turns anything unexpected into a generic 500 carrying the request id
 * (so a report can be matched to the log line) and logs the details server-side only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly format: 'json' | 'pretty', private readonly quiet = false) {}

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      return void res.status(exception.getStatus()).json(typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body);
    }
    const err = exception instanceof Error ? exception : new Error(String(exception));
    reportError(err, { requestId: req.id, method: req.method, path: loggablePath(req.originalUrl) });
    if (!this.quiet) writeLog(this.format, { level: 'error', msg: 'unhandled error', requestId: req.id, method: req.method, path: loggablePath(req.originalUrl), error: err.message, stack: err.stack });
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Internal server error', requestId: req.id });
  }
}
