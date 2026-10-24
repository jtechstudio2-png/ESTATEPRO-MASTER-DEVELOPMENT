/**
 * RFC 9457 problem details (ADR-003 §7). Every error response is built from a
 * ProblemError so status, type and wording stay consistent across the API.
 */

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ConflictingResource {
  type: string;
  id: string;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: FieldError[];
  conflictingResource?: ConflictingResource;
}

const TYPE_PREFIX = 'urn:estatepro:problem:';

export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly extras: Pick<ProblemBody, 'errors' | 'conflictingResource'> = {},
  ) {
    super(detail ?? title);
    this.name = 'ProblemError';
  }

  get type(): string {
    return `${TYPE_PREFIX}${this.code}`;
  }

  toBody(instance: string, requestId: string): ProblemBody {
    const body: ProblemBody = {
      type: this.type,
      title: this.title,
      status: this.status,
      instance,
      requestId,
    };
    if (this.detail !== undefined) body.detail = this.detail;
    if (this.extras.errors !== undefined) body.errors = this.extras.errors;
    if (this.extras.conflictingResource !== undefined) {
      body.conflictingResource = this.extras.conflictingResource;
    }
    return body;
  }
}

export const Problems = {
  malformedRequest: (detail: string) => new ProblemError(400, 'malformed-request', 'Malformed request', detail),

  unauthenticated: (detail = 'A valid access token is required.') =>
    new ProblemError(401, 'unauthenticated', 'Authentication required', detail),

  forbidden: (detail = 'You do not have permission to perform this action.') =>
    new ProblemError(403, 'forbidden', 'Forbidden', detail),

  mfaRequired: (detail = 'This action requires multi-factor authentication. Sign in again with a second factor.') =>
    new ProblemError(403, 'mfa-required', 'Multi-factor authentication required', detail),

  companyInactive: (detail: string) => new ProblemError(403, 'company-inactive', 'Company account not active', detail),

  notFound: (detail = "This record doesn't exist or you don't have access to it.") =>
    new ProblemError(404, 'not-found', 'Not found', detail),

  conflict: (detail: string, conflictingResource?: ConflictingResource) =>
    new ProblemError(409, 'conflict', 'Conflict', detail, conflictingResource ? { conflictingResource } : {}),

  preconditionFailed: (detail = 'This record was changed by someone else. Reload it and try again.') =>
    new ProblemError(412, 'precondition-failed', 'Precondition failed', detail),

  payloadTooLarge: (detail = 'The request body is too large.') =>
    new ProblemError(413, 'payload-too-large', 'Payload too large', detail),

  unsupportedMediaType: (detail = 'Send the request body as application/json.') =>
    new ProblemError(415, 'unsupported-media-type', 'Unsupported media type', detail),

  validation: (errors: FieldError[]) =>
    new ProblemError(
      422,
      'validation-failed',
      'Validation failed',
      errors.length === 1 ? '1 field is invalid.' : `${errors.length} fields are invalid.`,
      { errors },
    ),

  businessRule: (detail: string) => new ProblemError(422, 'business-rule-violated', 'Business rule violated', detail),

  idempotencyKeyReused: () =>
    new ProblemError(
      422,
      'idempotency-key-reused',
      'Idempotency key reused',
      'This Idempotency-Key was already used with a different request.',
    ),

  preconditionRequired: (detail = 'Send the If-Match header with the version you are updating.') =>
    new ProblemError(428, 'precondition-required', 'Precondition required', detail),

  internal: () =>
    new ProblemError(
      500,
      'internal-error',
      'Internal error',
      'Something went wrong on our side. Your changes were not saved. Quote the request ID if you contact support.',
    ),
} as const;
