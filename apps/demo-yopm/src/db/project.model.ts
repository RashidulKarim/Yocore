/**
 * Project model — a tiny demo of product-owned data.
 *
 * Stored in YoPM's own database. References YoCore identifiers (userId,
 * workspaceId) by string but never joins to YoCore tables.
 *
 * Multi-tenancy: every query MUST filter by workspaceId. The route layer
 * derives workspaceId from the signed-in YoCore session.
 */
import { Schema, type Connection, type Model } from 'mongoose';
import { randomBytes } from 'node:crypto';

export interface ProjectDoc {
  _id: string;
  workspaceId: string; // from YoCore — owns isolation
  ownerUserId: string; // YoCore user id
  name: string;
  description: string;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<ProjectDoc>(
  {
    _id: { type: String, required: true },
    workspaceId: { type: String, required: true, index: true },
    ownerUserId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 2000 },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  },
  { timestamps: true, collection: 'projects', _id: false },
);

projectSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });

export function getProjectModel(conn: Connection): Model<ProjectDoc> {
  return (
    conn.models['Project'] as Model<ProjectDoc> | undefined
    ?? conn.model<ProjectDoc>('Project', projectSchema)
  );
}

export function newProjectId(): string {
  return `proj_${randomBytes(12).toString('hex')}`;
}
