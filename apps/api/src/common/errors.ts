import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@djs/db';

/**
 * Stable, machine-readable error codes.
 *
 * The UI switches on `code`; `message` is for humans and may be reworded
 * freely. Mixing those two roles into one string is how frontends end up
 * matching on prose.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  QUEUE_PAUSED: 'QUEUE_PAUSED',
  UNKNOWN_HANDLER: 'UNKNOWN_HANDLER',
  INVALID_CRON: 'INVALID_CRON',
  CRON_TOO_FREQUENT: 'CRON_TOO_FREQUENT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  ILLEGAL_STATE_TRANSITION: 'ILLEGAL_STATE_TRANSITION',
  ALREADY_RESOLVED: 'ALREADY_RESOLVED',
  IN_USE: 'IN_USE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorDetail {
  field?: string;
  issue: string;
}

/** Every non-2xx response in the system has exactly this shape. */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    request_id: string;
    timestamp: string;
  };
}

export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: ErrorDetail[],
  ) {
    super(message, status);
  }

  static notFound(what: string): AppError {
    // Deliberately identical whether the row is missing or belongs to another
    // tenant. Distinguishing them turns 404 into an existence oracle that leaks
    // one tenant's data shape to another.
    return new AppError(ERROR_CODES.NOT_FOUND, `${what} not found`, HttpStatus.NOT_FOUND);
  }
  static forbidden(message = 'You do not have access to this resource'): AppError {
    return new AppError(ERROR_CODES.FORBIDDEN, message, HttpStatus.FORBIDDEN);
  }
  static conflict(code: ErrorCode, message: string): AppError {
    return new AppError(code, message, HttpStatus.CONFLICT);
  }
  static unprocessable(code: ErrorCode, message: string, details?: ErrorDetail[]): AppError {
    return new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
  static badRequest(message: string, details?: ErrorDetail[]): AppError {
    return new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      message,
      HttpStatus.BAD_REQUEST,
      details,
    );
  }
}

/**
 * Converts everything — AppError, Nest's built-ins, Prisma errors, and stray
 * throws — into one envelope.
 *
 * The Prisma mapping matters: an unhandled P2002 surfaces as a 500 with a stack
 * trace containing column names. Mapping it to 409 is both a better API and
 * less information disclosure.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req as { requestId?: string }).requestId ?? 'unknown';

    const { status, body } = this.translate(exception, requestId);

    // 5xx is our fault and gets the stack; 4xx is the caller's and gets a line.
    if (status >= 500) {
      this.logger.error(
        { requestId, path: req.url, err: exception },
        `Unhandled error: ${body.error.message}`,
      );
    } else {
      this.logger.debug({ requestId, path: req.url, code: body.error.code }, body.error.message);
    }

    res.status(status).json(body);
  }

  private translate(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ErrorEnvelope } {
    const envelope = (
      code: ErrorCode,
      message: string,
      details?: ErrorDetail[],
    ): ErrorEnvelope => ({
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        request_id: requestId,
        timestamp: new Date().toISOString(),
      },
    });

    if (exception instanceof AppError) {
      return {
        status: exception.getStatus(),
        body: envelope(exception.code, exception.message, exception.details),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      // Nest's ValidationPipe puts its field errors in `message` as an array.
      const details =
        typeof response === 'object' && response !== null && Array.isArray((response as never)['message'])
          ? ((response as { message: string[] }).message.map((m) => ({ issue: m })) as ErrorDetail[])
          : undefined;

      const message =
        typeof response === 'object' && response !== null && 'message' in response
          ? Array.isArray((response as { message: unknown }).message)
            ? 'Request validation failed'
            : String((response as { message: unknown }).message)
          : exception.message;

      return { status, body: envelope(this.codeForStatus(status), message, details) };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            body: envelope(
              ERROR_CODES.CONFLICT,
              `A record with that ${fieldsOf(exception).join(', ') || 'value'} already exists`,
            ),
          };
        case 'P2003':
          return {
            status: HttpStatus.BAD_REQUEST,
            body: envelope(ERROR_CODES.VALIDATION_ERROR, 'Referenced record does not exist'),
          };
        // ON DELETE RESTRICT — deleting a retry policy still in use by a queue.
        // A deliberate constraint, so it deserves a deliberate 409.
        case 'P2014':
          return {
            status: HttpStatus.CONFLICT,
            body: envelope(
              ERROR_CODES.IN_USE,
              'This record is still referenced by others and cannot be deleted',
            ),
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            body: envelope(ERROR_CODES.NOT_FOUND, 'Record not found'),
          };
      }
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      // Never echo an internal message to the caller — it may contain SQL,
      // column names, or connection strings. The request_id is the bridge to
      // the log line that has the detail.
      body: envelope(ERROR_CODES.INTERNAL_ERROR, 'An unexpected error occurred'),
    };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case 400:
        return ERROR_CODES.VALIDATION_ERROR;
      case 401:
        return ERROR_CODES.UNAUTHENTICATED;
      case 403:
        return ERROR_CODES.FORBIDDEN;
      case 404:
        return ERROR_CODES.NOT_FOUND;
      case 409:
        return ERROR_CODES.CONFLICT;
      case 413:
        return ERROR_CODES.PAYLOAD_TOO_LARGE;
      case 422:
        return ERROR_CODES.VALIDATION_ERROR;
      case 429:
        return ERROR_CODES.RATE_LIMITED;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
}

function fieldsOf(err: Prisma.PrismaClientKnownRequestError): string[] {
  const target = err.meta?.['target'];
  return Array.isArray(target) ? target.map(String) : [];
}
