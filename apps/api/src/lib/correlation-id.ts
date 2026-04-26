import { createNamespace, type Namespace } from 'cls-hooked';
import { ulid } from 'ulid';

const NS_NAME = 'yocore:correlation';
const KEY_CORRELATION_ID = 'correlationId';
const KEY_REQUEST_ID = 'requestId';

let ns: Namespace | undefined;

function getNs(): Namespace {
  if (!ns) ns = createNamespace(NS_NAME);
  return ns;
}

export function newCorrelationId(): string {
  return ulid();
}

export function runWithCorrelationId<T>(
  correlationId: string,
  fn: () => T,
  requestId?: string,
): T {
  const namespace = getNs();
  return namespace.runAndReturn(() => {
    namespace.set(KEY_CORRELATION_ID, correlationId);
    if (requestId) namespace.set(KEY_REQUEST_ID, requestId);
    return fn();
  });
}

export function getCorrelationId(): string | undefined {
  return getNs().get(KEY_CORRELATION_ID) as string | undefined;
}

export function getRequestId(): string | undefined {
  return getNs().get(KEY_REQUEST_ID) as string | undefined;
}
