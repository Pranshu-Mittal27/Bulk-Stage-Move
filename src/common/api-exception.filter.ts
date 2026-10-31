import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from './api-error.js';

interface ApiErrorResponse {
  statusCode: number;
  code: string;
  message: string;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    let errorResponse: ApiErrorResponse;
    if (exception instanceof ApiError) {
      errorResponse = {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
      };
    } else if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      errorResponse = {
        statusCode,
        code:
          statusCode === HttpStatus.BAD_REQUEST
            ? 'validation_error'
            : 'request_error',
        message:
          statusCode === HttpStatus.BAD_REQUEST
            ? 'Request validation failed.'
            : 'The request could not be completed.',
      };
    } else {
      errorResponse = {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'internal_error',
        message: 'An unexpected error occurred.',
      };
    }

    response.status(errorResponse.statusCode).json({
      ...errorResponse,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
