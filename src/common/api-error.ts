import { HttpException } from '@nestjs/common';

export class ApiError extends HttpException {
  constructor(
    statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message, statusCode);
  }
}
