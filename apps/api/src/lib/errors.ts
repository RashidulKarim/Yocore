/**
 * Re-export error primitives from @yocore/types so handlers/services have one
 * import path: `import { AppError, ErrorCode } from '../../lib/errors.js'`.
 */
export { AppError, ErrorCode, isAppError, httpStatusFor, httpStatusMap } from '@yocore/types';
