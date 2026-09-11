import { eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketSettings, personalProfiles } from "../db/schema.ts";
import { ProfileService } from "../profile/service.ts";
import { marketDigest, MarketStoreError } from "./repository.ts";

export function marketReadPolicy(db: RadarDb) {
  const settings = db.select().from(marketSettings).where(eq(marketSettings.ref, "local")).get();
  const active = db.select().from(personalProfiles).where(eq(personalProfiles.active, 1)).get();
  const profile = active ? new ProfileService(db).show(active.ref) : null;
  const blocked = [...new Set([...(settings?.payload.blocked_topics ?? []), ...(profile?.profile.blocked_topics ?? [])])].sort();
  return { blocked_topics: blocked, policy_revision: marketDigest({
    settings_revision: settings?.revision ?? 0, profile: profile?.ref ?? null,
    profile_revision: profile?.headRevision ?? null, blocked,
  }) };
}

export function assertMarketContentReadable(db: RadarDb, topics: string[]): void {
  const policy = marketReadPolicy(db);
  if (policy.blocked_topics.length && (!topics.length || topics.some(t => policy.blocked_topics.includes(t)))) {
    throw new MarketStoreError("content_blocked", "Content is blocked or has not been classified against the current policy.");
  }
}
