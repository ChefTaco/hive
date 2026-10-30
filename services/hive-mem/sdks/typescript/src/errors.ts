export class HiveMemError extends Error {}

export class HiveMemHTTPError extends HiveMemError {
  readonly statusCode: number;
  readonly details: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "HiveMemHTTPError";
    this.statusCode = statusCode;
    this.details = details;
  }
}
