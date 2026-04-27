/**
 * Baseline migration — no-op.
 *
 * The first migration in a project should record that the schema is at the
 * "v1" baseline so future migrations can rely on it. We deliberately do not
 * create indexes here; index creation is owned by the Mongoose models in
 * `src/db/models/*` and applied at boot via `syncIndexes()`.
 */

export async function up(): Promise<void> {
  // Intentional no-op. Marks the v1 baseline.
}

export async function down(): Promise<void> {
  // Cannot undo the baseline.
}
