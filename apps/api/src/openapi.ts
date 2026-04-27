/**
 * OpenAPI 3.1 spec generator (V1.0-J).
 *
 * Builds the spec at boot from the live Zod schemas in `@yocore/types` and
 * the route catalog below. Exposed as a static `GET /v1/openapi.json`.
 *
 * Strategy: rather than annotating every individual handler, we declare the
 * route catalog once here, mapping (method,path) \u2192 (request,response,scope).
 * This keeps schemas authoritative and the spec auto-tracking with code
 * because it imports the same Zod objects the handlers use.
 *
 * If a route omits a request/response schema, OpenAPI emits an empty body
 * (and the CI script `audit-openapi-routes.ts` will catch drift).
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z, type ZodTypeAny, type AnyZodObject } from 'zod';

import {
  // Auth
  signupRequestSchema,
  signupResponseSchema,
  signinRequestSchema,
  signinResponseSchema,
  refreshRequestSchema,
  refreshResponseSchema,
  logoutRequestSchema,
  finalizeOnboardingRequestSchema,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
  // Users / Self-service
  updateUserProfileRequestSchema,
  userProfileResponseSchema,
  listSessionsResponseSchema,
  currentTosResponseSchema,
  // Admin / Ops
  forceSubscriptionStatusRequestSchema,
  applySubscriptionCreditRequestSchema,
  forceCronRunRequestSchema,
  listWebhookDeliveriesQuerySchema,
  updateSuperAdminConfigRequestSchema,
  rotateJwtKeyResponseSchema,
  publishTosVersionRequestSchema,
  requestSelfDeletionRequestSchema,
} from '@yocore/types';

extendZodWithOpenApi(z);

interface RouteSpec {
  method: 'get' | 'post' | 'patch' | 'delete' | 'put';
  path: string;
  summary: string;
  tag: string;
  request?: ZodTypeAny;
  query?: AnyZodObject;
  response?: ZodTypeAny;
  /** "public" | "bearer" | "basic" \u2014 affects the security entry. */
  auth: 'public' | 'bearer' | 'basic';
  /** HTTP code for success. Default 200. */
  successStatus?: number;
}

const ROUTES: RouteSpec[] = [
  // Auth (public)
  {
    method: 'post',
    path: '/v1/auth/signup',
    tag: 'Auth',
    summary: 'Request a new product signup (constant-time, never reveals existence)',
    request: signupRequestSchema,
    response: signupResponseSchema,
    auth: 'public',
  },
  {
    method: 'post',
    path: '/v1/auth/signin',
    tag: 'Auth',
    summary: 'Sign in with email + password (+ optional MFA)',
    request: signinRequestSchema,
    response: signinResponseSchema,
    auth: 'public',
  },
  {
    method: 'post',
    path: '/v1/auth/refresh',
    tag: 'Auth',
    summary: 'Rotate refresh token \u2192 new access + refresh pair',
    request: refreshRequestSchema,
    response: refreshResponseSchema,
    auth: 'public',
  },
  {
    method: 'post',
    path: '/v1/auth/logout',
    tag: 'Auth',
    summary: 'Revoke current session (or all sessions)',
    request: logoutRequestSchema,
    auth: 'bearer',
    successStatus: 204,
  },
  {
    method: 'post',
    path: '/v1/auth/finalize-onboarding',
    tag: 'Auth',
    summary: 'Create first workspace + flip onboarded flag (Flow F12)',
    request: finalizeOnboardingRequestSchema,
    auth: 'bearer',
  },
  {
    method: 'get',
    path: '/v1/auth/verify-email',
    tag: 'Auth',
    summary: 'Verify email via token (Flow F10/F11)',
    query: verifyEmailRequestSchema,
    response: verifyEmailResponseSchema,
    auth: 'public',
  },
  {
    method: 'get',
    path: '/v1/tos/current',
    tag: 'Legal',
    summary: 'Current published Terms of Service + Privacy Policy versions',
    response: currentTosResponseSchema,
    auth: 'public',
  },

  // Self-service (Bearer)
  {
    method: 'get',
    path: '/v1/users/me',
    tag: 'Me',
    summary: 'Current user profile',
    response: userProfileResponseSchema,
    auth: 'bearer',
  },
  {
    method: 'patch',
    path: '/v1/users/me',
    tag: 'Me',
    summary: 'Update profile fields',
    request: updateUserProfileRequestSchema,
    response: userProfileResponseSchema,
    auth: 'bearer',
  },
  {
    method: 'delete',
    path: '/v1/users/me',
    tag: 'Me',
    summary: 'Request voluntary account or per-product deletion (30d grace)',
    request: requestSelfDeletionRequestSchema,
    auth: 'bearer',
    successStatus: 202,
  },
  {
    method: 'post',
    path: '/v1/users/me/cancel-deletion',
    tag: 'Me',
    summary: 'Cancel a pending deletion request during the grace window',
    auth: 'bearer',
  },
  {
    method: 'get',
    path: '/v1/users/me/deletion-requests',
    tag: 'Me',
    summary: 'List my pending and historical deletion requests',
    auth: 'bearer',
  },
  {
    method: 'get',
    path: '/v1/sessions',
    tag: 'Me',
    summary: 'List my active sessions',
    response: listSessionsResponseSchema,
    auth: 'bearer',
  },
  {
    method: 'delete',
    path: '/v1/sessions/{id}',
    tag: 'Me',
    summary: 'Revoke a single session',
    auth: 'bearer',
    successStatus: 204,
  },

  // Admin / Ops (Bearer + IP allowlist)
  {
    method: 'post',
    path: '/v1/admin/products/{productId}/subscriptions/{id}/force-status',
    tag: 'Admin',
    summary: 'Force a subscription status (audited)',
    request: forceSubscriptionStatusRequestSchema,
    auth: 'bearer',
  },
  {
    method: 'post',
    path: '/v1/admin/products/{productId}/subscriptions/{id}/apply-credit',
    tag: 'Admin',
    summary: 'Apply manual credit adjustment (minor units)',
    request: applySubscriptionCreditRequestSchema,
    auth: 'bearer',
  },
  {
    method: 'get',
    path: '/v1/admin/cron/status',
    tag: 'Admin',
    summary: 'List registered crons + last-run state',
    auth: 'bearer',
  },
  {
    method: 'post',
    path: '/v1/admin/cron/run',
    tag: 'Admin',
    summary: 'Force-run a registered cron once',
    request: forceCronRunRequestSchema,
    auth: 'bearer',
  },
  {
    method: 'get',
    path: '/v1/admin/webhook-deliveries',
    tag: 'Admin',
    summary: 'List outbound webhook deliveries (filterable)',
    query: listWebhookDeliveriesQuerySchema,
    auth: 'bearer',
  },
  {
    method: 'post',
    path: '/v1/admin/webhook-deliveries/{id}/retry',
    tag: 'Admin',
    summary: 'Force a retry of a single webhook delivery',
    auth: 'bearer',
  },
  {
    method: 'post',
    path: '/v1/admin/jwt/rotate-key',
    tag: 'Admin',
    summary: 'Rotate the active JWT signing key (Flow Y)',
    response: rotateJwtKeyResponseSchema,
    auth: 'bearer',
  },
  {
    method: 'get',
    path: '/v1/admin/super-admin/config',
    tag: 'Admin',
    summary: 'Read Super-Admin singleton config (incl. IP allowlist)',
    auth: 'bearer',
  },
  {
    method: 'patch',
    path: '/v1/admin/super-admin/config',
    tag: 'Admin',
    summary: 'Update Super-Admin singleton config',
    request: updateSuperAdminConfigRequestSchema,
    auth: 'bearer',
  },
  {
    method: 'post',
    path: '/v1/admin/tos',
    tag: 'Admin',
    summary: 'Publish a new Terms-of-Service or Privacy-Policy version (B-05)',
    request: publishTosVersionRequestSchema,
    auth: 'bearer',
  },
  {
    method: 'get',
    path: '/v1/admin/tos',
    tag: 'Admin',
    summary: 'List published ToS / Privacy versions',
    auth: 'bearer',
  },
];

let cachedSpec: ReturnType<OpenApiGeneratorV31['generateDocument']> | null = null;

export function buildOpenApiDocument(): ReturnType<
  OpenApiGeneratorV31['generateDocument']
> {
  if (cachedSpec) return cachedSpec;

  const registry = new OpenAPIRegistry();

  for (const r of ROUTES) {
    const responses: Record<string, { description: string; content?: { 'application/json': { schema: ZodTypeAny } } }> = {};
    if (r.response) {
      responses[String(r.successStatus ?? 200)] = {
        description: 'Success',
        content: { 'application/json': { schema: r.response } },
      };
    } else {
      responses[String(r.successStatus ?? 204)] = { description: 'Success' };
    }

    registry.registerPath({
      method: r.method,
      path: r.path,
      tags: [r.tag],
      summary: r.summary,
      security:
        r.auth === 'public'
          ? []
          : r.auth === 'bearer'
            ? [{ bearerAuth: [] }]
            : [{ basicAuth: [] }],
      ...(r.query
        ? { request: { query: r.query, ...(r.request ? { body: bodyOf(r.request) } : {}) } }
        : r.request
          ? { request: { body: bodyOf(r.request) } }
          : {}),
      responses,
    });
  }

  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
  registry.registerComponent('securitySchemes', 'basicAuth', {
    type: 'http',
    scheme: 'basic',
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  cachedSpec = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'YoCore Platform API',
      version: '1.0.0',
      description:
        'Unified backend API for the YoCore platform. ' +
        'See docs/openapi-strategy.md for stability guarantees.',
    },
    servers: [{ url: '/' }],
  });
  return cachedSpec;
}

function bodyOf(schema: ZodTypeAny) {
  return {
    required: true,
    content: { 'application/json': { schema } },
  };
}
