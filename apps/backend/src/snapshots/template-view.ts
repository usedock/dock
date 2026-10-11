import type { Template, TemplateStatus } from '../database/schema';

/** Public API shape of a template; built field by field so new columns are never exposed by default. */
export interface TemplateView {
  id: string;
  organizationId: string;
  name: string;
  sourceDockId: string | null;
  status: TemplateStatus;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
}

export function templateView(tpl: Template): TemplateView {
  return {
    id: tpl.id,
    organizationId: tpl.organizationId,
    name: tpl.name,
    sourceDockId: tpl.sourceDockId,
    status: tpl.status,
    sizeBytes: tpl.sizeBytes,
    createdAt: tpl.createdAt,
    updatedAt: tpl.updatedAt,
  };
}
