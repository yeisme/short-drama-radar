import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { openDb } from "../../src/db/client.ts";
import { opportunities } from "../../src/db/schema.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { buildEdition } from "../../src/pipeline/edition.ts";
import { evaluateReadingJudgment } from "../../src/judgment/consumer.ts";
import { createFixtureTransport } from "../../src/judgment/transport.ts";
import { createSDKHTTPTransport } from "../../src/judgment/sdk-http.ts";
import { judgmentEvaluateCommand } from "../../src/judgment/cli.ts";

const binary=process.env.RADAR_JUDGMENT_ADAPTER_TEST_BIN;
// The explicit system conformance run supplies Aigora's offline-only binary.
// Ordinary standalone Radar tests do not assume sibling repositories exist.
test.skipIf(!binary)("Radar CLI and SDK reach the real adapter with a network-free upstream", async()=>{
  const child=spawn(binary!,[],{stdio:["ignore","pipe","ignore"],env:{PATH:process.env.PATH}});
  const lines=createInterface({input:child.stdout!});
  const endpoint=await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error("mock adapter startup timeout"));},10000);
    lines.once("line",line=>{clearTimeout(timer);resolve(line);});
    child.once("exit",()=>{clearTimeout(timer);reject(new Error("mock adapter exited"));});
  });
  const db=openDb(":memory:");
  try {
    for (let n=0;n<2;n++) db.insert(opportunities).values({ref:`opp-sdk-${n}`,date:"2026-09-21",clusterKey:`revenge|identity_reversal|${n}`,topic:"revenge",hookFamily:"identity_reversal",format:"default",marketScore:80,evidenceConfidence:80,degraded:0,crossPlatform:0,evidenceDigest:`sha256:${"a".repeat(64)}`,sourceRefsJson:JSON.stringify([`douyin:synthetic-${n}`]),builderVersion:"opportunity-builder.v1",createdAt:"2026-09-21T00:00:00.000Z"}).run();
    const profile=new ProfileService(db).create("sdk",{topics:[{tag:"revenge",weight:90}],minimum_confidence:30,minimum_fit:30});
    buildEdition(db,profile,"2026-09-21");
    const target={kind:"edition"} as const;
    await evaluateReadingJudgment(db,{mode:"assist",transport:createFixtureTransport(),target});
    const make=()=>createSDKHTTPTransport({endpoint,model:"typesafe/jev-1.13",token:"fixture-adapter-only"});
    const transport=make();
    const first=await evaluateReadingJudgment(db,{mode:"assist",transport,target});
    expect(first.outcome).toBe("evaluated");
    expect(first.record?.error).toBeNull();
    expect(first.record?.sdk_input_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.record?.items.length).toBe(6);
    expect(first.record?.model.transport).toBe("sdk-http");
    const replayTransport=make();
    const replay=await evaluateReadingJudgment(db,{mode:"assist",transport:replayTransport,target});
    expect(replay.reused).toBe(true);
    expect(replayTransport.calls).toEqual({describe:0,evaluate:0});
    const shadow=await evaluateReadingJudgment(db,{mode:"shadow",transport:make(),target});
    expect(shadow.reused).toBe(false);
    expect(shadow.record?.mode).toBe("shadow");
    const old=process.env.RADAR_TEST_ADAPTER_ACCESS;
    process.env.RADAR_TEST_ADAPTER_ACCESS="fixture-adapter-only";
    try {
      const flags=new Map(Object.entries({mode:["assist"],transport:["http"],endpoint:[endpoint],model:["typesafe/jev-1.13"],"auth-env":["RADAR_TEST_ADAPTER_ACCESS"],fresh:["true"]}));
      const output=await judgmentEvaluateCommand(db,flags,{enabled:true,mode:"off"});
      expect(output.status).toBe("success");
      expect(JSON.stringify(output)).not.toContain("fixture-adapter-only");
      expect(JSON.stringify(output)).not.toContain("inline_text");
    } finally {if(old===undefined)delete process.env.RADAR_TEST_ADAPTER_ACCESS;else process.env.RADAR_TEST_ADAPTER_ACCESS=old;}
    const denied=await evaluateReadingJudgment(db,{mode:"assist",transport:createSDKHTTPTransport({endpoint,model:"typesafe/jev-1.13",token:"invalid-test-access"}),target,fresh:true});
    expect(denied.outcome).toBe("failed");
    expect(await (await fetch(endpoint+"/test/calls")).text()).toBe("3");
  } finally {db.$client.close();lines.close();child.kill();await new Promise<void>(resolve=>child.once("exit",()=>resolve()));}
},30000);

test("SDK transport rejects unsafe configuration before network",()=>{
  for(const endpoint of ["http://example.com","https://user:pass@example.com","https://example.com?token=x","https://example.com#x"]){
    expect(()=>createSDKHTTPTransport({endpoint,model:"typesafe/jev-1.13",token:"fixture-adapter-only"})).toThrow();
  }
});
