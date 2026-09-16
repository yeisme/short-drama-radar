import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { choice, cleanText, identifier, integer, invalid, type DecisionSample } from "./domain.ts";

export type SampleInput = Omit<DecisionSample, "content_digest" | "byte_length" | "verification" | "metadata_verification">;
export function normalizeSample(input: SampleInput): SampleInput {
  let locale: string;
  try { locale = Intl.getCanonicalLocales(cleanText(input.locale, "locale", 60))[0]!; }
  catch { return invalid("decision_input_invalid", "Sample locale must be a valid language tag."); }
  return { ref: identifier(input.ref, "sample"), candidate_ref: identifier(input.candidate_ref, "candidate"),
    artifact_ref: identifier(input.artifact_ref, "artifact"), version: identifier(input.version, "version"),
    owner: choice(input.owner, "owner", ["auctra", "scaena", "manual"]), episode: integer(input.episode, "episode", 1, 2),
    duration_seconds: integer(input.duration_seconds, "duration_seconds", 15, 600), locale,
    format: choice(input.format, "format", ["animation", "manga_drama"]) };
}

// Read one explicitly selected regular file, bounded and without persisting its
// path or bytes. O_NONBLOCK prevents hanging on a FIFO before fstat can reject it.
export function hashSampleFile(file: string) {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024) throw new Error("file");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let total = 0, size: number;
    while ((size = readSync(fd, buffer, 0, buffer.length, null))) {
      total += size;
      if (total > before.size) throw new Error("changed");
      hash.update(buffer.subarray(0, size));
    }
    const after = fstatSync(fd);
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("changed");
    return { content_digest: "sha256:" + hash.digest("hex"), byte_length: total };
  } catch { return invalid("sample_file_invalid", "Select a stable non-empty regular file up to 512 MiB; symlinks are not accepted."); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function exportDecisionPackage(output: string, payload: { digest: string }) {
  try { writeFileSync(output, JSON.stringify(payload, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  catch { return invalid("work_package_export_failed", "Cannot create local export; choose a new file in an existing writable directory."); }
  return { exported: true, digest: payload.digest, overwrite: false, external_actions: false };
}
