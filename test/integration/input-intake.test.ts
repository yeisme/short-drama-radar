import { expect,test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { rawSnapshots } from "../../src/db/schema.ts";
import { loadConfig } from "../../src/config.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { InputIntake } from "../../src/input-intake/service.ts";

test("input HTTP grants, one-time browser exchange and manual import are recoverable without collection",async()=>{
 const root=mkdtempSync(join(tmpdir(),"radar-input-")),db=openDb(join(root,"radar.db"));
 const deps={db,cfg:{...loadConfig(),dbPath:join(root,"radar.db")},profiles:new ProfileService(db)};
 let intake:InputIntake;
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:req=>intake.http(req)});
 try{
 const base=`http://127.0.0.1:${server.port}`;const opt={listen:`127.0.0.1:${server.port}`,baseURL:base,project:"creative-fixture"};
 intake=new InputIntake(deps,join(root,"files"),opt);
 const prepared=await intake.control("input.prepare",{purpose:"manual_evidence",idempotency_key:"same-task"});
 expect(prepared.request.state).toBe("awaiting_file");const id=prepared.request.input_request_id;
 const transfer=prepared.links.find(link=>link.uri.includes("#grant="))!.uri,grant=transfer.split("#grant=")[1]!,page=prepared.links.find(link=>link.uri.includes("#page="))!.uri;
 expect(JSON.stringify(prepared.request)).not.toContain(grant);
 const target=transfer.split("#")[0]!;
 const exchange=await fetch(target+"/exchange",{method:"POST",headers:{"Content-Type":"application/json",Origin:base},body:JSON.stringify({token:page.split("#page=")[1]})});expect(exchange.status).toBe(200);
 const replay=await fetch(target+"/exchange",{method:"POST",headers:{"Content-Type":"application/json",Origin:base},body:JSON.stringify({token:page.split("#page=")[1]})});expect(replay.status).toBe(403);
 const send=async(op:string,method:string,body?:string)=>fetch(target+"/"+op,{method,headers:{"X-Input-Grant":grant,"Content-Type":"application/json"},body});
 const csv="platform,title,url,likes\ndouyin,Creative reference,https://example.test/ref,42\n";
 expect((await send("file","POST",JSON.stringify({name:"evidence.csv",mime:"text/csv",size:Buffer.byteLength(csv)}))).status).toBe(200);
 expect((await send("content","PUT",csv)).status).toBe(200);
 expect((await send("complete","POST","{}")).status).toBe(200);
 expect((await send("complete","POST","{}")).status).toBe(200);
 expect(db.select().from(rawSnapshots).all()).toHaveLength(0);
 intake=new InputIntake(deps,join(root,"files"),opt);
 expect((await intake.control("input.status",{input_request_id:id})).request.state).toBe("ready");
 const imported=await intake.control("input.import",{input_request_id:id});expect(imported.request.receipt?.domain_state).toBe("imported_degraded_evidence");
 expect(db.select().from(rawSnapshots).all()).toHaveLength(1);
 await intake.control("input.import",{input_request_id:id});expect(db.select().from(rawSnapshots).all()).toHaveLength(1);
 const other=new InputIntake(deps,join(root,"files"),{...opt,project:"other"});await expect(other.control("input.status",{input_request_id:id})).rejects.toThrow();
 const foreign=await fetch(target+"/status",{headers:{"X-Input-Grant":grant,Origin:"https://foreign.example"}});expect(foreign.status).toBe(403);
 const blockedDir=join(root,"blocked-files");intake=new InputIntake(deps,blockedDir,opt);
 const pending=await intake.control("input.prepare",{purpose:"manual_evidence",idempotency_key:"storage-recovery"});
 const blockedURL=pending.links.find(link=>link.uri.includes("#grant="))!.uri;
 const callBlocked=async(op:string,method:string,body:string)=>fetch(blockedURL.split("#")[0]+"/"+op,{method,headers:{"X-Input-Grant":blockedURL.split("#grant=")[1]!,"Content-Type":"application/json"},body});
 expect((await callBlocked("file","POST",JSON.stringify({name:"evidence.csv",mime:"text/csv",size:Buffer.byteLength(csv)}))).status).toBe(200);
 rmdirSync(blockedDir);writeFileSync(blockedDir,"fixture storage unavailable");
 expect((await callBlocked("content","PUT",csv)).status).toBe(503);
 expect((await intake.control("input.status",{input_request_id:pending.request.input_request_id})).request.failure_code).toBe("storage_unavailable");
 unlinkSync(blockedDir);mkdirSync(blockedDir);
 expect((await callBlocked("content","PUT",csv)).status).toBe(200);
 expect((await callBlocked("complete","POST","{}")).status).toBe(200);
 for(const name of readdirSync(root)){if(name.endsWith("db"))expect(readFileSync(join(root,name)).includes(Buffer.from(grant))).toBe(false)}
 }finally{server.stop(true)}
});
