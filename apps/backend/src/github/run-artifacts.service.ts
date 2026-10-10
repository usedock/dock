import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { githubRunArtifacts } from '../database/schema';

export interface PublishedRunArtifact {
  name: string;
  content: string;
  sizeBytes: number;
  sha256: string;
}

/** Persists bounded Fast Run evidence before its guest runtime is destroyed. */
@Injectable()
export class RunArtifactsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async publish(runId: string, artifacts: Record<string, string>): Promise<PublishedRunArtifact[]> {
    const published: PublishedRunArtifact[] = [];
    for (const [name, content] of Object.entries(artifacts)) {
      const bytes = Buffer.byteLength(content, 'utf8');
      const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
      const [row] = await this.db
        .insert(githubRunArtifacts)
        .values({ runId, name, content, sizeBytes: bytes, sha256 })
        .onConflictDoUpdate({
          target: [githubRunArtifacts.runId, githubRunArtifacts.name],
          set: { content, sizeBytes: bytes, sha256, createdAt: new Date() },
        })
        .returning();
      published.push({ name: row.name, content: row.content, sizeBytes: row.sizeBytes, sha256: row.sha256 });
    }
    return published;
  }

  async list(runId: string): Promise<PublishedRunArtifact[]> {
    const rows = await this.db.select().from(githubRunArtifacts).where(eq(githubRunArtifacts.runId, runId));
    return rows.map(({ name, content, sizeBytes, sha256 }) => ({ name, content, sizeBytes, sha256 }));
  }
}
