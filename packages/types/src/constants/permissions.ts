/**
 * Platform RBAC catalog — single source of truth for the seed roles
 * (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`) and the canonical permission strings
 * referenced by `/v1/permissions/check` and `/v1/permissions/catalog`.
 *
 * Custom per-product roles are added at runtime in `roles` collection;
 * they may reference any string in `PLATFORM_PERMISSIONS` plus
 * product-defined permissions (which the API treats opaquely).
 */

export const PLATFORM_PERMISSIONS = [
  // Workspace
  'workspace.read',
  'workspace.update',
  'workspace.delete',
  'workspace.transfer',
  // Members
  'member.read',
  'member.invite',
  'member.remove',
  'member.role.update',
  // Billing
  'billing.read',
  'billing.update',
  'billing.cancel',
  // Roles
  'role.read',
  'role.create',
  'role.update',
  'role.delete',
  // Audit / settings
  'audit.read',
  'settings.read',
  'settings.update',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/** Wildcard granted to OWNERs only — matches every permission. */
export const WILDCARD_PERMISSION = '*' as const;

export interface PlatformRoleDefinition {
  slug: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  name: string;
  description: string;
  isDefault: boolean;
  /** Permissions granted to this role; OWNER gets `['*']` (wildcard). */
  permissions: readonly string[];
}

export const PLATFORM_ROLES: readonly PlatformRoleDefinition[] = [
  {
    slug: 'OWNER',
    name: 'Owner',
    description: 'Full control of the workspace.',
    isDefault: false,
    permissions: [WILDCARD_PERMISSION],
  },
  {
    slug: 'ADMIN',
    name: 'Administrator',
    description: 'Manage members, roles, and settings.',
    isDefault: false,
    permissions: [
      'workspace.read',
      'workspace.update',
      'member.read',
      'member.invite',
      'member.remove',
      'member.role.update',
      'role.read',
      'role.create',
      'role.update',
      'role.delete',
      'billing.read',
      'audit.read',
      'settings.read',
      'settings.update',
    ],
  },
  {
    slug: 'MEMBER',
    name: 'Member',
    description: 'Standard collaborator.',
    isDefault: true,
    permissions: ['workspace.read', 'member.read', 'settings.read'],
  },
  {
    slug: 'VIEWER',
    name: 'Viewer',
    description: 'Read-only access.',
    isDefault: false,
    permissions: ['workspace.read', 'member.read'],
  },
];

/** Map slug → ordinal rank (higher = more privileged). */
export const ROLE_RANK: Record<string, number> = {
  OWNER: 40,
  ADMIN: 30,
  MEMBER: 20,
  VIEWER: 10,
};

/**
 * Returns true when a wildcard permission is held OR the exact permission is
 * present in `granted`. Custom permissions are matched case-sensitively.
 */
export function permissionGranted(
  granted: readonly string[],
  required: string,
): boolean {
  if (granted.includes(WILDCARD_PERMISSION)) return true;
  return granted.includes(required);
}
