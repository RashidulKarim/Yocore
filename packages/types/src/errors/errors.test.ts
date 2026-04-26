import { describe, it, expect } from 'vitest';
import { AppError, ErrorCode, httpStatusFor, isAppError } from './index.js';

describe('ErrorCode + AppError', () => {
  it('every ErrorCode has an http status mapping', () => {
    for (const code of Object.values(ErrorCode)) {
      const status = httpStatusFor(code);
      expect(status, `missing mapping for ${code}`).toBeGreaterThanOrEqual(200);
      expect(status, `bad mapping for ${code}`).toBeLessThan(600);
    }
  });

  it('AppError carries code + message + details', () => {
    const err = new AppError(ErrorCode.VALIDATION_FAILED, 'bad', { field: 'email' });
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toBe('bad');
    expect(err.details).toEqual({ field: 'email' });
    expect(isAppError(err)).toBe(true);
  });

  it('AppError.from passes through existing AppError', () => {
    const orig = new AppError(ErrorCode.NOT_FOUND, 'nope');
    expect(AppError.from(orig)).toBe(orig);
  });

  it('AppError.from wraps Error as INTERNAL_ERROR by default', () => {
    const wrapped = AppError.from(new Error('boom'));
    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.message).toBe('boom');
  });

  it('AppError.from wraps unknown values', () => {
    const wrapped = AppError.from('weird');
    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.message).toBe('Unknown error');
    expect(wrapped.cause).toBe('weird');
  });

  it('toResponseJSON includes correlationId when provided', () => {
    const err = new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'no');
    expect(err.toResponseJSON('cid_1')).toEqual({
      error: 'AUTH_INVALID_CREDENTIALS',
      message: 'no',
      correlationId: 'cid_1',
    });
  });

  it('toResponseJSON omits details when not set', () => {
    const err = new AppError(ErrorCode.NOT_FOUND, 'nope');
    expect(err.toResponseJSON()).toEqual({ error: 'NOT_FOUND', message: 'nope' });
  });
});
