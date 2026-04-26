/**
 * Permission service — `/v1/permissions/check` + `/v1/permissions/catalog`.
 *
 * Hot path: the API key middleware in front of these endpoints already
 * resolved `productId`, so all queries here are tenant-scoped.
 *
 * Cache (per FIX-PERM): 60s TTL keyed by `perm:<productId>:<userId>:<workspaceId>`.
 * Mutations elsewhere (member changes, role updates, ownership transfer)
 * publish `cache:invalidate <key>` on Redis pub/sub. We listen via
 * `subscribePermInvalidation` and DEL the local cache key.
 */
import type { Redis } from 'ioredis';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  permissionGranted,
} from '@yocore/types';
import * as workspaceMemberRepo from '../repos/workspace-member.repo.js';
import * as roleRepo from '../repos/role.repo.js';

const PERM_CACHE_TTL = 60;
const CACHE_INVALIDATE_CHANNEL = 'cache:invalidate';

function permKey(productId: string, userId: string, workspaceId: string): string {
  return `perm:${productId}:${userId}:${workspaceId}`;
}

export interface CheckPermissionsInput {
  productId: string;
  userId: string;
  workspaceId: string;
  permissions: string[];
}

export interface CheckPermissionsOutcome {
  userId: string;
  workspaceId: string;
  roleSlug: string | null;
  results: Record<string, boolean>;
  cached: boolean;
}

interface PermissionService {
  check(input: CheckPermissionsInput): Promise<CheckPermissionsOutcome>;
  catalog(productId: string): Promise<{
    permissions: string[];
    roles: Array<{ slug: string; name: string; isPlatform: boolean; permissions: string[] }>;
  }>;
  invalidate(productId: string, userId: string, workspaceId: string): Promise<void>;
}

interface CachedPerms {
  roleSlug: string | null;
  granted: string[];
}

export interface CreatePermissionServiceDeps {
  redis: Redis;
}

export function createPermissionService(deps: CreatePermissionServiceDeps): PermissionService {
  async function loadFromMongo(input: CheckPermissionsInput): Promise<CachedPerms> {
    const member = await workspaceMemberRepo.findMember(
      input.productId,
      input.workspaceId,
      input.userId,
    );
    if (!member || member.status !== 'ACTIVE') {
      return { roleSlug: null, granted: [] };
    }
    const role = await roleRepo.findById(input.productId, member.roleId);
    if (!role) return { roleSlug: member.roleSlug, granted: [] };
    return { roleSlug: role.slug, granted: [...role.permissions] };
  }

  async function readCache(key: string): Promise<CachedPerms | null> {
    const raw = await deps.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedPerms;
    } catch {
      return null;
    }
  }

  return {
    async check(input) {
      const key = permKey(input.productId, input.userId, input.workspaceId);
      let cached = true;
      let perms = await readCache(key);
      if (!perms) {
        cached = false;
        perms = await loadFromMongo(input);
        await deps.redis.set(key, JSON.stringify(perms), 'EX', PERM_CACHE_TTL);
      }
      const results: Record<string, boolean> = {};
      for (const p of input.permissions) {
        results[p] = perms.granted.length > 0 && permissionGranted(perms.granted, p);
      }
      return {
        userId: input.userId,
        workspaceId: input.workspaceId,
        roleSlug: perms.roleSlug,
        results,
        cached,
      };
    },

    async catalog(productId) {
      const customRoles = await roleRepo.listForProduct(productId);
      const known = new Set(customRoles.map((r) => r.slug));
      const platform = PLATFORM_ROLES.filter((r) => !known.has(r.slug)).map((r) => ({
        slug: r.slug,
        name: r.name,
        isPlatform: true,
        permissions: [...r.permissions],
      }));
      const dbRoles = customRoles.map((r) => ({
        slug: r.slug,
        name: r.name,
        isPlatform: r.isPlatform,
        permissions: [...r.permissions],
      }));
      return {
        permissions: [...PLATFORM_PERMISSIONS],
        roles: [...platform, ...dbRoles],
      };
    },

    async invalidate(productId, userId, workspaceId) {
      const key = permKey(productId, userId, workspaceId);
      await deps.redis.del(key);
      // Best-effort cluster-wide invalidation. Other API pods subscribed via
      // `subscribePermInvalidation` will DEL their local copy too.
      await deps.redis.publish(CACHE_INVALIDATE_CHANNEL, key);
    },
  };
}

/**
 * Subscribe a Redis client (separate connection — pub/sub mode) to the
 * cache-invalidation channel. The handler DELs the matching local key so a
 * subsequent check re-reads from Mongo.
 */
export async function subscribePermInvalidation(
  subscriber: Redis,
  cacheClient: Redis,
): Promise<void> {
  await subscriber.subscribe(CACHE_INVALIDATE_CHANNEL);
  subscriber.on('message', (channel, message) => {
    if (channel !== CACHE_INVALIDATE_CHANNEL) return;
    if (!message.startsWith('perm:')) return;
    void cacheClient.del(message);
  });
}

export type { PermissionService };
