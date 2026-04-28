/**
 * V1.2-A — Product Roles screen (Screen 14).
 *
 * Lists platform + custom roles for a product, lets SUPER_ADMIN create, edit
 * or delete custom roles. Platform roles (OWNER/ADMIN/MEMBER/VIEWER) are
 * read-only and visually marked.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { ErrorAlert, Empty } from '../components/ui.js';

interface RoleRow {
  id: string;
  productId: string;
  slug: string;
  name: string;
  description: string | null;
  isPlatform: boolean;
  isDefault: boolean;
  permissions: string[];
  inheritsFrom: string | null;
  memberCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

interface CatalogResponse {
  permissions: string[];
  roles: { slug: string; name: string; isPlatform: boolean; permissions: string[] }[];
}

export function ProductRolesPage() {
  const { productId = '' } = useParams<{ productId: string }>();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rolesQ = useQuery({
    queryKey: ['admin', 'roles', productId],
    queryFn: () => api<{ roles: RoleRow[] }>('GET', `/v1/admin/products/${productId}/roles`),
    enabled: !!productId,
  });

  const catalogQ = useQuery({
    queryKey: ['admin', 'permissions-catalog', productId],
    queryFn: () =>
      api<CatalogResponse>('GET', `/v1/admin/products/${productId}/permissions-catalog`),
    enabled: !!productId,
  });

  const deleteMut = useMutation({
    mutationFn: (roleId: string) =>
      api('DELETE', `/v1/admin/products/${productId}/roles/${roleId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'roles', productId] }),
    onError: (e: unknown) =>
      setError(e instanceof ApiError ? e.message : String(e)),
  });

  function onDelete(role: RoleRow): void {
    setError(null);
    if (role.memberCount > 0) {
      setError(`Cannot delete: ${role.memberCount} active members hold this role.`);
      return;
    }
    if (!confirm(`Delete role "${role.name}" (${role.slug})? This cannot be undone.`)) return;
    deleteMut.mutate(role.id);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Roles & Permissions</h1>
        <div className="flex gap-3">
          <Link to={`/products/${productId}`} className="text-sm text-brand-700 hover:underline">
            ← Back to product
          </Link>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            + New custom role
          </button>
        </div>
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      <div className="card overflow-hidden p-0">
        {rolesQ.error && <div className="p-4"><ErrorAlert>{(rolesQ.error as Error).message}</ErrorAlert></div>}
        {rolesQ.isLoading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {rolesQ.data && (rolesQ.data.roles.length === 0 ? <Empty>No roles defined.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Slug</th>
                <th className="th">Name</th>
                <th className="th">Type</th>
                <th className="th">Permissions</th>
                <th className="th">Members</th>
                <th className="th">Inherits</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {rolesQ.data.roles.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="td font-mono text-xs">{r.slug}</td>
                  <td className="td">{r.name}</td>
                  <td className="td">
                    {r.isPlatform ? (
                      <span className="rounded bg-slate-200 px-2 py-0.5 text-xs">Platform</span>
                    ) : (
                      <span className="rounded bg-brand-100 px-2 py-0.5 text-xs text-brand-700">
                        Custom
                      </span>
                    )}
                  </td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1">
                      {r.permissions.slice(0, 6).map((p) => (
                        <span
                          key={p}
                          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px]"
                        >
                          {p}
                        </span>
                      ))}
                      {r.permissions.length > 6 && (
                        <span className="text-xs text-slate-500">
                          +{r.permissions.length - 6} more
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="td">{r.memberCount}</td>
                  <td className="td font-mono text-xs">{r.inheritsFrom ?? '—'}</td>
                  <td className="td space-x-2 text-right">
                    {!r.isPlatform && (
                      <>
                        <button className="btn btn-secondary text-xs" onClick={() => setEditing(r)}>
                          Edit
                        </button>
                        <button
                          className="btn btn-danger text-xs"
                          onClick={() => onDelete(r)}
                          disabled={deleteMut.isPending}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>

      {creating && (
        <RoleEditor
          productId={productId}
          mode="create"
          allRoles={rolesQ.data?.roles ?? []}
          permissionCatalog={catalogQ.data?.permissions ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['admin', 'roles', productId] });
          }}
        />
      )}
      {editing && (
        <RoleEditor
          productId={productId}
          mode="edit"
          role={editing}
          allRoles={rolesQ.data?.roles ?? []}
          permissionCatalog={catalogQ.data?.permissions ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['admin', 'roles', productId] });
          }}
        />
      )}
    </div>
  );
}

interface RoleEditorProps {
  productId: string;
  mode: 'create' | 'edit';
  role?: RoleRow;
  allRoles: RoleRow[];
  permissionCatalog: string[];
  onClose: () => void;
  onSaved: () => void;
}

function RoleEditor({
  productId,
  mode,
  role,
  allRoles,
  permissionCatalog,
  onClose,
  onSaved,
}: RoleEditorProps) {
  const [slug, setSlug] = useState(role?.slug ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  const [inheritsFrom, setInheritsFrom] = useState<string>(role?.inheritsFrom ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (mode === 'create') {
        return api('POST', `/v1/admin/products/${productId}/roles`, {
          body: {
            slug,
            name,
            description: description || undefined,
            permissions,
            inheritsFrom: inheritsFrom || undefined,
          },
          idempotencyKey: `role-create-${productId}-${slug}-${Date.now()}`,
        });
      }
      return api('PATCH', `/v1/admin/products/${productId}/roles/${role!.id}`, {
        body: {
          name,
          description: description || null,
          permissions,
          inheritsFrom: inheritsFrom || null,
        },
        idempotencyKey: `role-update-${productId}-${role!.id}-${Date.now()}`,
      });
    },
    onSuccess: onSaved,
    onError: (e: unknown) => {
      setError(e instanceof ApiError ? e.message : String(e));
    },
  });

  function togglePerm(p: string): void {
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-2xl space-y-4 bg-white">
        <h2 className="text-lg font-semibold">
          {mode === 'create' ? 'Create custom role' : `Edit ${role?.name}`}
        </h2>
        {error && <ErrorAlert>{error}</ErrorAlert>}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Slug</label>
            <input
              className="input"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toUpperCase())}
              placeholder="EDITOR"
              disabled={mode === 'edit'}
            />
            <p className="mt-1 text-xs text-slate-500">Uppercase letters, digits, underscores. Immutable after create.</p>
          </div>
          <div>
            <label className="label">Display name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="label">Description (optional)</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div>
          <label className="label">Inherits from (optional)</label>
          <select
            className="input"
            value={inheritsFrom}
            onChange={(e) => setInheritsFrom(e.target.value)}
          >
            <option value="">— None —</option>
            {allRoles
              .filter((r) => r.id !== role?.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.slug})
                </option>
              ))}
          </select>
        </div>

        <div>
          <label className="label">Permissions</label>
          <div className="grid max-h-64 grid-cols-2 gap-1 overflow-y-auto rounded border p-2">
            {permissionCatalog.length === 0 && (
              <p className="col-span-2 p-2 text-xs text-slate-500">
                Permission catalog unavailable. You can still type permissions manually below.
              </p>
            )}
            {permissionCatalog.map((p) => (
              <label key={p} className="flex items-center gap-2 rounded p-1 text-xs hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={permissions.includes(p)}
                  onChange={() => togglePerm(p)}
                />
                <span className="font-mono">{p}</span>
              </label>
            ))}
          </div>
          <textarea
            className="input mt-2 font-mono text-xs"
            rows={3}
            placeholder="Or paste comma- or newline-separated permission strings"
            value={permissions.join('\n')}
            onChange={(e) =>
              setPermissions(
                e.target.value
                  .split(/[\n,]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              setError(null);
              save.mutate();
            }}
            disabled={save.isPending || !name || (mode === 'create' && !slug)}
          >
            {save.isPending ? 'Saving…' : mode === 'create' ? 'Create role' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
