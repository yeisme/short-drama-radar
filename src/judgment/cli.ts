import { createSDKHTTPTransport } from "./sdk-http.ts";
import type { RadarDb } from "../db/client.ts";
import type { RadarJudgmentConfig } from "../config.ts";
import type { CommandResult } from "../output/envelope.ts";
import type { ChineseLocale } from "../market/translation.ts";
import { JudgmentConsumerError, evaluateReadingJudgment, listReadingJudgmentKeys, parseJudgmentMode, showReadingJudgment, type JudgmentMode, type ReadingJudgmentRecord } from "./consumer.ts";
import { policyRef, questionSetRef } from "./questionset.ts";
import { FIXTURE_TRANSPORT_NAME, createFixtureTransport, FIXTURE_SCENARIOS, type FixtureScenario } from "./transport.ts";
import { acceptReadingSuggestion, readingJudgmentEvidence } from "./evidence.ts";
import { READING_JUDGMENT_CALIBRATION } from "./calibration.ts";

// CLI surface for the optional reading-judgment consumer. Every command is
// local; `evaluate` is the only one that can reach a transport and it
// requires an explicit shadow/assist opt-in. Default everywhere is off.
//
// Task 2.1 adds the user-config experimental gate (config section
// `judgment`: enabled default false, mode off/shadow/assist default off).
// While enabled=false the operational commands (evaluate, accept) refuse to
// run before any flag parsing, transport assembly or write: the capability
// stays fully dormant. status/show/evidence remain available because they
// are zero-call, zero-write read-only surfaces over already-stored evidence.

const JUDGMENT_DISABLED_MESSAGE =
  "Experimental judgment capability is not enabled; set {\"judgment\": {\"enabled\": true, \"mode\": \"shadow\"}} " +
  "(or mode assist) in the Radar config file to opt in. While disabled the judgment surface stays fully dormant: " +
  "zero transport assembly, zero model calls, zero writes.";

function requireJudgmentEnabled(config: RadarJudgmentConfig): void {
  if (!config.enabled) throw new JudgmentConsumerError("capability_disabled", JUDGMENT_DISABLED_MESSAGE);
}

export function judgmentStatusCommand(db: RadarDb, judgment: RadarJudgmentConfig): CommandResult {
  const attempts = listReadingJudgmentKeys(db, 5);
  const summary = judgment.enabled
    ? `Reading judgment is ENABLED (experimental); default mode '${judgment.mode}' from config, CLI --mode overrides; ${attempts.length} stored attempt(s).`
    : `Reading judgment is DISABLED by default (experimental; opt in via config judgment.enabled=true); ${attempts.length} stored attempt(s) stay read-only.`;
  return {
    command: "radar.judgment.status",
    status: "success",
    summary,
    facts: {
      experimental_enabled: judgment.enabled,
      default_mode: judgment.mode,
      readiness: "exploratory",
      wired_transports: [FIXTURE_TRANSPORT_NAME, "http"],
      model_calls_this_command: 0,
      stored_attempts: attempts.length,
    },
    data: {
      question_set: questionSetRef(),
      policy: policyRef(),
      modes: ["off (default)", "shadow (comparison only; no adoption)", "assist (advisory suggestions; adoption still gated)"],
      config: { enabled: judgment.enabled, mode: judgment.mode, note: "mode is the evaluate default once enabled; --mode overrides it per run; nothing but an explicit user config edit enables this capability" },
      calibration: READING_JUDGMENT_CALIBRATION,
      note: "Public SDK HTTP transport requires explicit endpoint, model and adapter token environment name; nothing auto-enables it.",
    },
    actions: judgment.enabled
      ? [{ name: "evaluate", command: `radar judgment evaluate --target edition --mode ${judgment.mode === "assist" ? "assist" : "shadow"} --transport fixture` }]
      : [{ name: "enable", command: "edit Radar config.json: judgment.enabled=true + judgment.mode shadow|assist (experimental)" }],
    exitCode: 0,
  };
}

export async function judgmentEvaluateCommand(db: RadarDb, flags: Map<string, string[]>, judgment: RadarJudgmentConfig): Promise<CommandResult> {
  // Gate first: while the experimental config gate is closed, no flag is
  // parsed, no transport is constructed and nothing is written.
  requireJudgmentEnabled(judgment);
  const value = (name: string): string => {
    const values = flags.get(name);
    if (!values || values.length !== 1 || values[0] === "true" || values[0] === "") {
      throw new JudgmentConsumerError("value_required", "Provide one value for --" + name + ".");
    }
    return values[0];
  };
  for (const key of flags.keys()) {
    if (!["mode", "target", "transport", "edition", "language", "profile", "fresh", "scenario", "endpoint", "model", "auth-env"].includes(key)) {
      throw new JudgmentConsumerError("flag_invalid", "Unsupported judgment flag.");
    }
  }
  // Config section `judgment.mode` is the default mode source once the
  // capability is enabled; an explicit CLI --mode overrides it per run.
  const rawMode = flags.has("mode") ? value("mode") : judgment.mode;
  const mode = parseJudgmentMode(rawMode);
  if (mode !== "shadow" && mode !== "assist") {
    throw new JudgmentConsumerError(
      "mode_required",
      "Judgment default mode is off; pass --mode shadow (comparison only) or --mode assist (advisory suggestions), or set judgment.mode in the Radar config, to opt in explicitly.",
    );
  }
  const transportName = flags.has("transport") ? value("transport") : FIXTURE_TRANSPORT_NAME;
  if (transportName !== FIXTURE_TRANSPORT_NAME && transportName !== "fixture" && transportName !== "http") {
    throw new JudgmentConsumerError(
      "transport_unavailable",
      "Use fixture or explicitly configured http transport.",
    );
  }
  let scenario: FixtureScenario = "answered";
  if (flags.has("scenario")) {
    const raw = value("scenario");
    if (!FIXTURE_SCENARIOS.includes(raw as FixtureScenario)) {
      throw new JudgmentConsumerError("scenario_invalid", `--scenario must be one of ${FIXTURE_SCENARIOS.join("|")} (fixture transport only).`);
    }
    scenario = raw as FixtureScenario;
  }
  const targetKind = flags.has("target") ? value("target") : "edition";
  if (targetKind !== "edition" && targetKind !== "reading") {
    throw new JudgmentConsumerError("target_invalid", "--target must be edition or reading.");
  }
  const language = flags.has("language") ? value("language") : "zh-Hans";
  if (language !== "zh-Hans" && language !== "zh-Hant") {
    throw new JudgmentConsumerError("language_invalid", "--language must be zh-Hans or zh-Hant.");
  }
  if (flags.has("fresh") && flags.get("fresh")?.join() !== "true") {
    throw new JudgmentConsumerError("flag_invalid", "Use --fresh without a value.");
  }

  let transport;
  if (transportName === "http") {
    if(flags.has("scenario")) throw new JudgmentConsumerError("flag_invalid", "--scenario is fixture-only.");
    const endpoint=value("endpoint"), model=value("model"), authEnv=value("auth-env");
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnv)) throw new JudgmentConsumerError("flag_invalid","--auth-env must name an environment variable.");
    try {transport=createSDKHTTPTransport({endpoint,model,token:process.env[authEnv]??""});}
    catch {throw new JudgmentConsumerError("transport_config_invalid","Provide HTTPS or loopback endpoint, explicit model, and a configured adapter-token environment variable.");}
  } else {
    if(["endpoint","model","auth-env"].some(k=>flags.has(k))) throw new JudgmentConsumerError("flag_invalid","HTTP configuration requires --transport http.");
    transport=createFixtureTransport({scenario});
  }
  const outcome = await evaluateReadingJudgment(db, {
    mode,
    transport,
    target: targetKind === "edition"
      ? { kind: "edition", ...(flags.has("edition") ? { editionRef: value("edition") } : {}), ...(flags.has("profile") ? { profileRef: value("profile") } : {}) }
      : { kind: "reading", language: language as ChineseLocale },
    fresh: flags.has("fresh"),
  });
  if (outcome.outcome === "off") {
    return {
      command: "radar.judgment.evaluate",
      status: "success",
      summary: "Judgment mode is off; nothing was projected, called or written.",
      facts: { mode: "off", transport_calls: 0 },
      exitCode: 0,
    };
  }
  const record = outcome.record!;
  const suggestionCount = record.suggestions.length;
  const adoptable = record.suggestions.filter((s) => s.adoptable).length;
  const summary = outcome.reused
    ? `Replayed stored judgment ${record.attempt_key} with zero transport calls (${record.execution_status}).`
    : record.execution_status === "succeeded" || record.execution_status === "partial"
      ? `Judgment attempt ${record.attempt_key} (${record.mode}, ${record.execution_status}) produced ${suggestionCount} advisory suggestion(s), ${adoptable} adoptable; original flow unchanged.`
      : `Judgment attempt ${record.attempt_key} ended '${record.execution_status}'${record.error ? ` (${record.error.code}, ${record.error.retry_class})` : ""}; original flow unchanged.`;
  return {
    command: "radar.judgment.evaluate",
    status: record.execution_status === "succeeded" ? "success" : "partial",
    summary,
    facts: {
      mode: record.mode,
      execution_status: record.execution_status,
      attempt_key: record.attempt_key,
      reused: outcome.reused,
      transport_evaluate_calls: outcome.transport_evaluate_calls,
      transport_describe_calls: transport.calls.describe,
      suggestions: suggestionCount,
      adoptable,
      advisory_only: true,
    },
    evidence: [`attempt_key=${record.attempt_key}`, `input_digest=${record.input_digest}`],
    data: { record: sanitizeForOutput(record), transport_calls: transport.calls },
    actions: [{ name: "show", command: `radar judgment show --attempt ${record.attempt_key}` }],
    exitCode: 0,
  };
}

export function judgmentShowCommand(db: RadarDb, attemptKey: string | undefined): CommandResult {
  if (!attemptKey) throw new JudgmentConsumerError("attempt_required", "judgment show requires --attempt <key>.");
  const record = showReadingJudgment(db, attemptKey);
  if (!record) throw new JudgmentConsumerError("attempt_not_found", `No stored judgment attempt '${attemptKey}'.`);
  return {
    command: "radar.judgment.show",
    status: "success",
    summary: `Judgment ${record.attempt_key} (${record.mode}, ${record.execution_status}) replayed with zero network calls.`,
    facts: {
      attempt_key: record.attempt_key,
      execution_status: record.execution_status,
      network_calls: 0,
      suggestions: record.suggestions.length,
      advisory_only: true,
    },
    evidence: [`attempt_key=${record.attempt_key}`, `input_digest=${record.input_digest}`],
    data: sanitizeForOutput(record),
    actions: record.suggestions.filter((s) => s.adoptable && s.binding_kind === "edition_entry").slice(0, 3)
      .map((s) => ({ name: "review", command: `radar feedback add --opportunity ${s.ref} --kind <kind>` })),
    exitCode: 0,
  };
}

// Records shown through the CLI never carry inline source texts — only
// digests, bindings and sanitized answers.
function sanitizeForOutput(record: ReadingJudgmentRecord): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    spec: record.spec,
    attempt_key: record.attempt_key,
    request_id: record.request_id,
    attempt_id: record.attempt_id,
    mode: record.mode,
    target: record.target,
    created_at: record.created_at,
    question_set: record.question_set,
    policy: record.policy,
    model: record.model,
    input_digest: record.input_digest,
    ...(record.sdk_input_digest ? {sdk_input_digest:record.sdk_input_digest} : {}),
    bindings: {
      authorization: record.bindings.authorization,
      edition_digest: record.bindings.edition_digest ?? null,
      candidates: record.bindings.candidates.map((c) => ({
        candidate_id: c.candidate_id,
        binding: c.binding,
        deterministic: c.deterministic,
      })),
    },
    execution_status: record.execution_status,
    items: record.items,
    suggestions: record.suggestions,
    baseline: record.baseline,
    usage: record.usage,
    latency_ms: record.latency_ms,
    provider_request_id: record.provider_request_id,
    error: record.error,
    limitations: record.limitations,
    accepted: record.accepted,
  })) as Record<string, unknown>;
}

export function judgmentAcceptCommand(db: RadarDb, flags: Map<string, string[]>, judgment: RadarJudgmentConfig): CommandResult {
  // Adoption hands off to the original feedback flow (a real mutation), so
  // it is gated behind the same experimental switch as evaluate.
  requireJudgmentEnabled(judgment);
  const value = (name: string): string => {
    const values = flags.get(name);
    if (!values || values.length !== 1 || values[0] === "true" || values[0] === "") {
      throw new JudgmentConsumerError("value_required", "Provide one value for --" + name + ".");
    }
    return values[0];
  };
  for (const key of flags.keys()) {
    if (!["attempt", "candidate", "kind", "key"].includes(key)) {
      throw new JudgmentConsumerError("flag_invalid", "Unsupported judgment flag.");
    }
  }
  const outcome = acceptReadingSuggestion(db, {
    attempt_key: value("attempt"),
    candidate_id: value("candidate"),
    kind: value("kind"),
    ...(flags.has("key") ? { idempotency_key: value("key") } : {}),
  });
  if (outcome.executed) {
    return {
      command: "radar.judgment.accept",
      status: "success",
      summary: `Suggestion adopted through the original feedback flow: '${outcome.kind}' recorded${outcome.already_accepted ? " (idempotent replay)" : ""} for ${outcome.receipt.opportunityRef}.`,
      facts: {
        executed: true,
        surface: outcome.surface,
        kind: outcome.kind,
        feedback_id: outcome.receipt.id,
        opportunity_ref: outcome.receipt.opportunityRef,
        network_calls: 0,
      },
      evidence: outcome.review_refs,
      actions: [{ name: "rebuild", command: "radar edition build" }],
      exitCode: 0,
    };
  }
  return {
    command: "radar.judgment.accept",
    status: "partial",
    summary: `Suggestion handed back to the original ${outcome.surface} flow; no business mutation was executed by the judgment module.`,
    facts: { executed: false, surface: outcome.surface, network_calls: 0 },
    data: { reason: outcome.reason, handoff: outcome.handoff.commands },
    actions: outcome.handoff.commands.map((command, i) => ({ name: `handoff-${i + 1}`, command })),
    exitCode: 0,
  };
}

export function judgmentEvidenceCommand(db: RadarDb, attemptKey: string | undefined): CommandResult {
  if (!attemptKey) throw new JudgmentConsumerError("attempt_required", "judgment evidence requires --attempt <key>.");
  const evidence = readingJudgmentEvidence(db, attemptKey);
  return {
    command: "radar.judgment.evidence",
    status: "success",
    summary: `Sanitized evidence for ${evidence.attempt.attempt_key} (${evidence.attempt.mode}, ${evidence.execution.status}); refs and digests only, zero network.`,
    facts: { attempt_key: evidence.attempt.attempt_key, execution_status: evidence.execution.status, network_calls: 0 },
    data: evidence as unknown as Record<string, unknown>,
    exitCode: 0,
  };
}
