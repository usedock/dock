import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { profiles, type Profile } from '../database/schema';
import { DB, Db } from '../database/database.module';

export interface ProfilePatch {
  displayName?: string;
  avatarUrl?: string | null;
  bio?: string;
}

/** Owner-scoped profile read/update. */
@Injectable()
export class ProfilesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getByUserId(userId: string): Promise<Profile> {
    const rows = await this.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    const profile = rows[0];
    if (!profile) {
      throw new NotFoundException({ code: 'not_found', message: 'Profile not found' });
    }
    return profile;
  }

  /** Fully validated before write: invalid input leaves the row untouched. */
  async update(userId: string, patch: ProfilePatch): Promise<Profile> {
    const [updated] = await this.db
      .update(profiles)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(profiles.userId, userId))
      .returning();
    if (!updated) {
      throw new NotFoundException({ code: 'not_found', message: 'Profile not found' });
    }
    return updated;
  }
}
