import { createHash } from "node:crypto";
import { HttpTransport, JudgmentClient, JudgmentError as SDKError, parseRequest, type Capabilities, type ModelIdentity } from "@yeisme/judgment-sdk";
import { JudgmentError, requestInputDigest, type JudgmentRequest, type JudgmentResult } from "./contract.ts";
import type { JudgmentTransport, JudgmentTransportCapabilities } from "./transport.ts";

export interface SDKHTTPOptions {
  endpoint: string;
  model: string;
  token: string;
  fetchImpl?: typeof fetch;
}

// This bridge preserves Radar's persisted v1 domain projection. Only its
// ephemeral transport wire becomes the public SDK's canonical contract.
export function sdkRequest(request: JudgmentRequest, model: ModelIdentity) {
  return parseRequest(JSON.stringify({
    schema_version: "1.0", request_id: request.request_id, attempt_id: request.attempt_id,
    scope: {owner_id: request.scope.owner, project_id: request.scope.project, principal_id: request.scope.principal, subject: null},
    model: {transport_provider:model.transportProvider, model_provider:model.modelProvider, requested_model:model.requestedModel,
      response_model:null, underlying_revision:model.underlyingRevision, pin_level:model.pinLevel, underlying_revision_verified:model.underlyingRevisionVerified},
    question_set: request.question_set, policy_ref: request.policy_ref,
    sources: request.sources.map(s => ({...s, revision:String(s.revision), local_ref:null})),
    candidates: request.candidates.map(c => ({candidate_id:c.candidate_id, source_bindings:c.source_ids.map(source_id=>({source_id}))})),
    questions: request.questions.map(q => ({question_id:q.question_id, primitive:q.primitive.kind, prompt:q.question_text,
      candidate_ids:q.candidate_ids, required:q.required,
      answer_domain:q.primitive.kind === "choice" ? {options:q.primitive.options.map(option_id=>({option_id,label:option_id}))}
        : q.primitive.kind === "ordinal_score" ? {levels:q.primitive.levels.map(l=>({...l,label:l.level_id}))} : null})),
    limits:request.limits, extensions:[],
  }));
}

export function createSDKHTTPTransport(options: SDKHTTPOptions): JudgmentTransport & {calls:{describe:number;evaluate:number}} {
  let url: URL;
  try {url=new URL(options.endpoint);} catch {throw new Error("Invalid judgment endpoint.");}
  const loopback = ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error("Judgment endpoint requires HTTPS or loopback HTTP, without credentials, query or fragment.");
  }
  if (!options.token || /\s/.test(options.token)) throw new Error("An adapter access token is required.");
  if (!options.model || options.model.length>200 || /\s/.test(options.model)) throw new Error("An explicit judgment model is required.");
  const endpoint=url.toString().replace(/\/$/,"");
  const binding=createHash("sha256").update(JSON.stringify({endpoint,model:options.model,bridge:"radar-sdk-http.v1"})).digest("hex");
  const calls={describe:0,evaluate:0};
  const client=new JudgmentClient(new HttpTransport({baseUrl:endpoint,headers:()=>({Authorization:`Bearer ${options.token}`}),fetchImpl:options.fetchImpl,maxOutputBytes:64000}));
  let caps:Capabilities | undefined;
  function convert(error:unknown): JudgmentError {
    if (error instanceof SDKError) return new JudgmentError(error.code,"Judgment adapter request failed.",error.submissionState,error.retryClass,"sdk-http");
    return new JudgmentError("invalid_response","Judgment contract validation failed.","unknown","reconcile_first","sdk-http");
  }
  return {
    transport:"sdk-http", ops:["DescribeCapabilities","Evaluate"], calls,
    cacheBinding:binding, requestedModel:options.model,
    async describeCapabilities():Promise<JudgmentTransportCapabilities> {
      calls.describe++;
      try {
        caps=await client.capabilities(AbortSignal.timeout(10000));
        if(caps.model.requestedModel!==options.model) throw new JudgmentError("unsupported_capability","Adapter does not advertise the selected model.","not_submitted","never","model-selection");
        return {schema_version:"1.0",transport:"sdk-http",adapter:caps.adapter.name,adapter_version:caps.adapter.version,
          models:[{transport_provider:caps.model.transportProvider,model_provider:caps.model.modelProvider??"unknown",model:caps.model.requestedModel,modalities:[...caps.modalities],primitives:[...caps.primitives]}],
          max_batch_candidates:caps.maxCandidates,max_questions:caps.maxQuestions,max_input_bytes:caps.maxInlineTextBytes,max_output_bytes:64000,
          languages_note:caps.languages.join(","),probability_available:caps.probabilityAvailable,confidence_available:caps.confidenceAvailable,
          confidence_provenance:caps.confidenceProvenance,reconcile_supported:caps.supportsReconcile,cancel_supported:caps.supportsCancel,idempotency_note:"No implicit retry; owner replay only"};
      } catch(e) {if(e instanceof JudgmentError)throw e;throw convert(e);}
    },
    async evaluate(request:JudgmentRequest):Promise<JudgmentResult> {
      if(!caps)throw new JudgmentError("unsupported_capability","Discover capabilities before evaluation.","not_submitted","never","sdk-http");
      let parsed;
      try {parsed=sdkRequest(request,caps.model);} catch {throw new JudgmentError("invalid_request","Domain projection does not satisfy the SDK contract.","not_submitted","never","sdk-http");}
      calls.evaluate++;
      try {
        const result=await client.evaluate(parsed);
        return {schema_version:"1.0",request_id:request.request_id,attempt_id:request.attempt_id,input_digest:requestInputDigest(request),
          sdk_input_digest:result.inputDigest,
          resolved_model:{transport_provider:result.resolvedModel.transportProvider,model_provider:result.resolvedModel.modelProvider??"unknown",model:result.resolvedModel.responseModel??result.resolvedModel.requestedModel},
          execution_status:result.executionStatus,
          items:result.items.map(i=>({candidate_id:i.candidateId,question_id:i.questionId,answer_status:i.answerStatus,
            value:i.value===null?null:i.value.optionId!==undefined?{option_id:i.value.optionId}:i.value.levelId!==undefined?{level_id:i.value.levelId}:{binary:i.value.binary!},
            distribution:i.distribution?{...i.distribution}:null,confidence:i.confidence,probability_true:i.probabilityTrue,reason_code:i.reasonCode})),
          usage:result.usage,latency_ms:result.latencyMs,provider_request_id:result.providerRequestId};
      }catch(e){throw convert(e);}
    },
  };
}
