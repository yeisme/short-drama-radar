import { and, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { personalProfiles, personalProfileRevisions } from "../db/schema.ts";
import { defaultProfile, profileDigest, validateProfile, type PersonalProfileV1 } from "./domain.ts";

// Profile application service — the only structured write path for profiles
// Every mutation creates a new
// immutable revision; activating a profile deactivates the previous one
// inside a transaction so the single-active invariant always holds.

export interface ProfileRecord {
  ref: string;
  name: string;
  active: boolean;
  headRevision: number;
  profile: PersonalProfileV1;
  digest: string;
  createdAt: string;
  updatedAt: string;
}

export interface RevisionRecord {
  profileRef: string;
  revision: number;
  profile: PersonalProfileV1;
  digest: string;
  createdAt: string;
}

export class ProfileService {
  constructor(private readonly db: RadarDb) {}

  create(name: string, overrides: Partial<PersonalProfileV1> = {}): ProfileRecord {
    const candidate = { ...defaultProfile(name), ...overrides, spec: "radar.personal_profile.v1" as const };
    const outcome = validateProfile(candidate);
    if (!outcome.ok) throw new ProfileError("profile_invalid", outcome.problems.join("; "));
    const ref = `profile-${slug(name)}`;
    const existing = this.db.select().from(personalProfiles).where(eq(personalProfiles.ref, ref)).all();
    if (existing.length > 0) throw new ProfileError("profile_exists", `profile '${ref}' already exists`);
    const now = new Date().toISOString();
    const digest = profileDigest(candidate);
    // First profile becomes active automatically; later ones need activate.
    const anyActive = this.db.select().from(personalProfiles).where(eq(personalProfiles.active, 1)).all().length > 0;
    this.db.transaction((tx) => {
      tx.insert(personalProfiles).values({ ref, name, active: anyActive ? 0 : 1, headRevision: 1, createdAt: now, updatedAt: now }).run();
      tx.insert(personalProfileRevisions).values({ profileRef: ref, revision: 1, profileJson: JSON.stringify(candidate), digest, createdAt: now }).run();
    });
    return { ref, name, active: !anyActive, headRevision: 1, profile: candidate, digest, createdAt: now, updatedAt: now };
  }

  list(): ProfileRecord[] {
    return this.db.select().from(personalProfiles).all().map((row) => this.hydrate(row));
  }

  show(ref?: string): ProfileRecord {
    const row = ref ? this.byRef(ref) : this.activeRow();
    if (!row) {
      throw new ProfileError("profile_required", ref ? `profile '${ref}' not found` : "no active profile; run 'radar profile create --name <name>' first");
    }
    return this.hydrate(row);
  }

  // `set` applies field patches and lands them as a new immutable revision.
  set(ref: string | undefined, patches: Partial<PersonalProfileV1>): ProfileRecord {
    const current = this.show(ref);
    const candidate = { ...current.profile, ...patches, spec: "radar.personal_profile.v1" as const };
    const outcome = validateProfile(candidate);
    if (!outcome.ok) throw new ProfileError("profile_invalid", outcome.problems.join("; "));
    const digest = profileDigest(candidate);
    const nextRevision = current.headRevision + 1;
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.update(personalProfiles).set({ headRevision: nextRevision, updatedAt: now }).where(eq(personalProfiles.ref, current.ref)).run();
      tx.insert(personalProfileRevisions).values({ profileRef: current.ref, revision: nextRevision, profileJson: JSON.stringify(candidate), digest, createdAt: now }).run();
    });
    return { ...current, headRevision: nextRevision, profile: candidate, digest, updatedAt: now };
  }

  activate(ref: string): ProfileRecord {
    const row = this.byRef(ref);
    if (!row) throw new ProfileError("profile_not_found", `profile '${ref}' not found`);
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.update(personalProfiles).set({ active: 0 }).where(eq(personalProfiles.active, 1)).run();
      tx.update(personalProfiles).set({ active: 1, updatedAt: now }).where(eq(personalProfiles.ref, ref)).run();
    });
    return this.show(ref);
  }

  revisions(ref: string): RevisionRecord[] {
    return this.db.select().from(personalProfileRevisions).where(eq(personalProfileRevisions.profileRef, ref)).all()
      .map((r) => ({ profileRef: r.profileRef, revision: r.revision, profile: JSON.parse(r.profileJson) as PersonalProfileV1, digest: r.digest, createdAt: r.createdAt }));
  }

  revision(ref: string, revision: number): RevisionRecord | null {
    const rows = this.db.select().from(personalProfileRevisions)
      .where(and(eq(personalProfileRevisions.profileRef, ref), eq(personalProfileRevisions.revision, revision))).all();
    const r = rows[0];
    return r ? { profileRef: r.profileRef, revision: r.revision, profile: JSON.parse(r.profileJson) as PersonalProfileV1, digest: r.digest, createdAt: r.createdAt } : null;
  }

  private activeRow() {
    return this.db.select().from(personalProfiles).where(eq(personalProfiles.active, 1)).all()[0];
  }

  private byRef(ref: string) {
    return this.db.select().from(personalProfiles).where(eq(personalProfiles.ref, ref)).all()[0];
  }

  private hydrate(row: typeof personalProfiles.$inferSelect): ProfileRecord {
    const rev = this.revision(row.ref, row.headRevision)!;
    return {
      ref: row.ref,
      name: row.name,
      active: row.active === 1,
      headRevision: row.headRevision,
      profile: rev.profile,
      digest: rev.digest,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export class ProfileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileError";
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}
