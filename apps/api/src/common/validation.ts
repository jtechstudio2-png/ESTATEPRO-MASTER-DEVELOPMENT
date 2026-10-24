import { ValidationPipe, type ValidationError } from '@nestjs/common';

import { type FieldError, Problems } from './problem.js';

const MESSAGES: Record<string, string> = {
  whitelistValidation: 'This field is not allowed.',
};

function codeFor(constraint: string): string {
  if (constraint === 'whitelistValidation') return 'unknown-field';
  return constraint.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  const result: FieldError[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    for (const [constraint, message] of Object.entries(error.constraints ?? {})) {
      result.push({ field, code: codeFor(constraint), message: MESSAGES[constraint] ?? message });
    }
    if (error.children && error.children.length > 0) {
      result.push(...flattenValidationErrors(error.children, field));
    }
  }
  return result;
}

/** Rejects unknown fields and returns 422 problems with one entry per field (ADR-003 §5). */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => Problems.validation(flattenValidationErrors(errors)),
  });
}
