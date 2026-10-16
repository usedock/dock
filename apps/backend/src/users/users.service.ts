import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { profiles, users, type User } from '../database/schema';
import { DB, Db } from '../database/database.module';
import { OrganizationsService } from '../organizations/organizations.service';

/** Account persistence. All emails normalized to lowercase before write. */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
  ) {}

  normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  async findByEmail(email: string): Promise<User | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, this.normalize(email)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** User + profile + personal org in one transaction (seed and ops tooling). */
  async createWithOrg(email: string): Promise<User> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email: this.normalize(email) })
        .returning();
      await tx.insert(profiles).values({ userId: user.id });
      await this.orgs.provisionPersonalOrg(tx, { userId: user.id, email: user.email });
      return user;
    });
  }

  /** Profile + personal org + verification sync for Better Auth-created users. */
  async provisionBetterAuthUser(input: {
    id: string;
    email: string;
    name?: string | null;
    emailVerified: boolean;
  }): Promise<void> {
    const email = this.normalize(input.email);
    const name = input.name?.trim() || undefined;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(profiles)
        .values({ userId: input.id, displayName: name?.slice(0, 60) })
        .onConflictDoNothing();
      if (input.emailVerified) {
        await tx
          .update(users)
          .set({ emailVerified: true, emailVerifiedAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, input.id));
      }
      await this.orgs.provisionPersonalOrg(tx, { userId: input.id, email, name });
    });
  }
}
