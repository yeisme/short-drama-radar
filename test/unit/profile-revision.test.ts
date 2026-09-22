import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { ProfileService } from "../../src/profile/service.ts";

describe("profile set revision semantics", () => {
  test("a no-op set does not mint a revision (L4)", () => {
    // Re-setting an identical value used to bump headRevision, inflating
    // canary profileAdjustment metrics and marking live editions/assignments
    // stale although nothing changed. Content-identical profiles share a
    // digest and must not advance the revision.
    const dir = mkdtempSync(join(tmpdir(), "radar-profile-"));
    const db = openDb(join(dir, "t.db"));
    const svc = new ProfileService(db);
    const created = svc.create("noop", { topics: [{ tag: "revenge", weight: 90 }], minimum_fit: 30, minimum_confidence: 30 });
    const reapply = svc.set(created.ref, { minimum_fit: 30 });
    expect(reapply.headRevision).toBe(created.headRevision);
    expect(reapply.digest).toBe(created.digest);
    const changed = svc.set(created.ref, { minimum_fit: 40 });
    expect(changed.headRevision).toBe(created.headRevision + 1);
    expect(changed.digest).not.toBe(created.digest);
    db.$client.close();
  });
});
