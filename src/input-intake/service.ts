import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, linkSync, existsSync, constants } from "node:fs";
import { join, basename } from "node:path";
import { and, eq } from "drizzle-orm";
import { inputRequests, runs } from "../db/schema.ts";
import type { AppDeps } from "../app/actions.ts";
import { importAction } from "../app/actions.ts";
import { parseImportCsv } from "../adapters/manual-import.ts";

const SCHEMA="yeisme.input_intake.v1", MAX=2<<20, PREFIX="/input-requests/";
const hash=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex");
const token=()=>randomBytes(32).toString("hex");
class InputError extends Error {constructor(readonly status:number,readonly code:string){super("Input request rejected; query or renew the original owner request")}}
const denied=()=>new InputError(403,"input_denied");
function storageError(error:unknown):InputError|undefined {const code=(error as {code?:string})?.code;if(code==="ENOSPC"||code==="EDQUOT")return new InputError(507,"storage_capacity_unavailable");if(["EACCES","EPERM","ENOTDIR","EROFS","EIO"].includes(code??""))return new InputError(503,"storage_unavailable");return undefined;}
type FileMeta={name:string;mime:string;size:number;sha256?:string};
type RecordState={id:string;revision:number;project:string;purpose:string;intent:string;state:string;expires:number;file?:FileMeta;pageHash:string;pageExpires:number;grantHash:string;grantExpires:number;browserHash?:string;browserExpires?:number;failure?:string;lease?:number;importState?:string;importRef?:string};
export type InputOptions={listen:string;baseURL:string;project:string};
export const INPUT_ACTIONS = ["input.prepare","input.status","input.renew","input.abort","input.import"] as const;
export function inputSchemas() {return INPUT_ACTIONS.map(action=>({action,inputSchema: action==="input.prepare" ? {type:"object",properties:{purpose:{type:"string",enum:["manual_evidence"]},idempotency_key:{type:"string",minLength:1,maxLength:256},file:{type:"object",properties:{name:{type:"string"},mime:{type:"string",enum:["text/csv","text/plain"]},size:{type:"integer",minimum:1,maximum:MAX},sha256:{type:"string"}},required:["name","mime","size"],additionalProperties:false}},required:["purpose","idempotency_key"],additionalProperties:false}:{type:"object",properties:{input_request_id:{type:"string",pattern:"^inp_[a-f0-9]{32}$"}},required:["input_request_id"],additionalProperties:false}}));}
export class InputIntake {
 private readonly origin:string;
 constructor(private deps:AppDeps,private dir:string,readonly options:InputOptions,private now=()=>Date.now()) {
  const url=new URL(options.baseURL);if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=="/"||!options.project)throw denied();this.origin=url.origin;
  mkdirSync(dir,{recursive:true,mode:0o700});
 }
 capabilities(){return {schema_version:SCHEMA,owner:"radar",enabled:true,project:this.options.project,purposes:["manual_evidence"],mime_types:["text/csv","text/plain"],max_bytes:MAX,transports:["http_put","browser"],tool:"radar.execute",action_schemas:inputSchemas(),authorization:"explicit operator connection with input listener enabled; no collection or profile authority",http:{grant_header:"X-Input-Grant",metadata_path:PREFIX+"{input_request_id}/file",content_path:PREFIX+"{input_request_id}/content",complete_path:PREFIX+"{input_request_id}/complete"}};}
 private get(id:string):RecordState {if(!/^inp_[a-f0-9]{32}$/.test(id))throw denied();const row=this.deps.db.select().from(inputRequests).where(and(eq(inputRequests.id,id),eq(inputRequests.project,this.options.project))).get();if(!row)throw denied();return JSON.parse(row.payload) as RecordState;}
 private save(r:RecordState){const old=r.revision;r.revision++;const changed=this.deps.db.update(inputRequests).set({revision:r.revision,payload:JSON.stringify(r)}).where(and(eq(inputRequests.id,r.id),eq(inputRequests.revision,old))).returning({id:inputRequests.id}).all();if(changed.length!==1)throw denied();}
 private active(r:RecordState){if(["ready","cancelled"].includes(r.state)||this.now()>=r.expires)throw denied();}
 view(r:RecordState){const state= !["ready","cancelled"].includes(r.state)&&this.now()>=r.expires?"expired":r.failure?"failed":r.state;return {schema_version:SCHEMA,input_request_id:r.id,project:r.project,purpose:r.purpose,state,resume_state:r.failure?r.state:undefined,failure_code:r.failure,max_bytes:MAX,mime_types:["text/csv","text/plain"],expires_at:new Date(r.expires).toISOString(),file:r.file,receipt:r.state==="ready"?{ref:"radar://input/"+r.id,sha256:r.file!.sha256,size:r.file!.size,domain_state:r.importState??"requires_manual_import"}:undefined,import_ref:r.importRef};}
 private access(r:RecordState,page:string,grant:string){return {request:this.view(r),links:[{type:"resource_link" as const,name:"Choose evidence CSV",uri:this.origin+PREFIX+r.id+"#page="+page},{type:"resource_link" as const,name:"Native HTTP transfer",uri:this.origin+PREFIX+r.id+"#grant="+grant}]};}
 private validateFile(value:unknown):FileMeta {const f=value as FileMeta;if(!f||typeof f.name!=="string"||f.name.length>255||basename(f.name)!==f.name||/[\\\x00\r\n]/.test(f.name)||!f.name||f.name==="."||f.name===".."||!['text/csv','text/plain'].includes(f.mime)||!Number.isSafeInteger(f.size)||f.size<1||f.size>MAX||(f.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(f.sha256))||Object.keys(f).some(k=>!['name','mime','size','sha256'].includes(k)))throw denied();return f;}
 private bind(r:RecordState,value:unknown){this.active(r);const f=this.validateFile(value);if(r.file){if(r.file.name!==f.name||r.file.mime!==f.mime||r.file.size!==f.size||(f.sha256&&r.file.sha256&&f.sha256!==r.file.sha256))throw denied();return;}r.file=f;r.state="prepared";this.save(r);}
 async control(action:string,args:Record<string,unknown>){
  if(!INPUT_ACTIONS.includes(action as typeof INPUT_ACTIONS[number]))throw denied();
  if(action==="input.prepare"){
   if(args.purpose!=="manual_evidence"||typeof args.idempotency_key!=="string"||!args.idempotency_key||args.idempotency_key.length>256||Object.keys(args).some(k=>!["purpose","idempotency_key","file"].includes(k)))throw denied();
   if(args.file)this.validateFile(args.file);
   const id="inp_"+hash(JSON.stringify(["stdio-operator",this.options.project,args.idempotency_key])).slice(0,32),intent=hash(JSON.stringify([args.purpose,args.file ? (()=>{const f=this.validateFile(args.file);return [f.name,f.mime,f.size,f.sha256??""]})() : null]));
   const existing=this.deps.db.select().from(inputRequests).where(eq(inputRequests.id,id)).get();if(existing){const r=this.get(id);if(r.intent!==intent)throw denied();return {request:this.view(r),links:[]};}
   const page=token(),grant=token(),now=this.now();const r:RecordState={id,revision:1,project:this.options.project,purpose:"manual_evidence",intent,state:"awaiting_file",expires:now+86400000,pageHash:hash(page),pageExpires:now+900000,grantHash:hash(grant),grantExpires:now+300000};
   this.deps.db.transaction(tx=>{if(tx.select().from(inputRequests).where(eq(inputRequests.project,this.options.project)).all().filter(row=>{const v=JSON.parse(row.payload) as RecordState;return v.expires>now&&!["ready","cancelled"].includes(v.state)}).length>=128)throw new InputError(507,"storage_capacity_unavailable");tx.insert(inputRequests).values({id,revision:1,project:r.project,payload:JSON.stringify(r)}).run()});
   if(args.file)this.bind(r,args.file);return this.access(r,page,grant);
  }
  if(Object.keys(args).some(k=>k!=="input_request_id"))throw denied();const r=this.get(String(args.input_request_id));
  if(action==="input.status"&&r.importState==="unconfirmed"&&r.importRef){const run=this.deps.db.select().from(runs).where(eq(runs.id,r.importRef)).get();if(run){r.importState=run.status==="ok"?"imported_degraded_evidence":"imported_with_rejections";this.save(r)}}
  if(action==="input.status")return {request:this.view(r),links:[]};
  if(action==="input.renew"){this.active(r);const page=token(),grant=token();r.pageHash=hash(page);r.pageExpires=Math.min(this.now()+900000,r.expires);r.grantHash=hash(grant);r.grantExpires=Math.min(this.now()+300000,r.expires);this.save(r);return this.access(r,page,grant);}
  if(action==="input.abort"){if(r.state==="ready"||(r.lease??0)>this.now())throw denied();r.state="cancelled";r.pageHash=r.grantHash="";this.save(r);if(existsSync(join(this.dir,r.id)))unlinkSync(join(this.dir,r.id));return {request:this.view(r),links:[]};}
  if(r.state!=="ready")throw denied();if(r.importState)return {request:this.view(r),links:[]};
  if(!r.file?.sha256||hash(readFileSync(join(this.dir,r.id)))!==r.file.sha256)throw denied();
  r.importState="unconfirmed";r.importRef="import-input-"+r.id;this.save(r);
  // Existing manual import application service only. No adapter discovery or profile changes.
  const result=await importAction(this.deps,join(this.dir,r.id),undefined,r.importRef);
  r.importState=result.status==="success"?"imported_degraded_evidence":"imported_with_rejections";r.importRef=result.evidence?.[0]?.replace(/^run_id=/,"");this.save(r);
  return {request:this.view(r),links:[]};
 }
 private matches(secret:string|undefined,digest:string|undefined){return !!secret&&!!digest&&secret.length===64&&timingSafeEqual(Buffer.from(hash(secret)),Buffer.from(digest));}
 async http(request:Request):Promise<Response>{
  const headers={"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'","X-Frame-Options":"DENY"};
  const reply=(value:unknown,status=200,extra:Record<string,string>={})=>Response.json(value,{status,headers:{...headers,...extra}});
  try{
   const url=new URL(request.url),origin=request.headers.get("origin");if(url.origin!==this.origin||request.headers.has("authorization")||(origin&&origin!==this.origin)||(request.headers.get("sec-fetch-site")==="cross-site"&&request.method!=="GET"))throw denied();
   const match=/^\/input-requests\/(inp_[a-f0-9]{32})(?:\/(file|content|complete|status|abort|exchange|app.js|style.css))?$/.exec(url.pathname);if(!match)return reply({error:"not_found"},404);const [,id,op]=match;
   if(request.method==="GET"&&!op)return new Response(readFileSync(new URL("./upload.html",import.meta.url),"utf8").replace("./PLACEHOLDER",id+"/app.js").replace("./STYLESHEET",id+"/style.css"),{headers:{...headers,"Content-Type":"text/html; charset=utf-8"}});
   if(request.method==="GET"&&op==="style.css")return new Response(readFileSync(new URL("./style.css",import.meta.url)),{headers:{...headers,"Content-Type":"text/css"}});
   if(request.method==="GET"&&op==="app.js")return new Response(readFileSync(new URL("./upload.js",import.meta.url)),{headers:{...headers,"Content-Type":"text/javascript"}});
   const json=async()=>{const raw=await boundedBody(request,16<<10);return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)) as Record<string,unknown>};
   let r=this.get(id!);
   if(request.method==="POST"&&op==="exchange"){this.active(r);const input=await json();if(Object.keys(input).length!==1||!this.matches(String(input.token),r.pageHash)||r.pageExpires<=this.now())throw denied();const secret=token();r.pageHash="";r.browserHash=hash(secret);r.browserExpires=Math.min(this.now()+900000,r.expires);this.save(r);return reply({exchanged:true},200,{"Set-Cookie":`input_session=${secret}; Path=${PREFIX}${r.id}; HttpOnly; SameSite=Strict; Max-Age=900${this.origin.startsWith("https:")?"; Secure":""}`});}
   const cookie=request.headers.get("cookie")?.split(/;\s*/).find(v=>v.startsWith("input_session="))?.slice(14),grant=request.headers.get("X-Input-Grant")??undefined;
   if(cookie&&grant)throw denied();if(cookie&&request.method!=="GET"&&origin!==this.origin)throw denied();if(!this.matches(cookie??grant,cookie?r.browserHash:r.grantHash)||(cookie?r.browserExpires??0:r.grantExpires)<=this.now())throw denied();
   if(request.method==="GET"&&op==="status")return reply(this.view(r));
   if(request.method==="POST"&&op==="file"){this.bind(r,await json());return reply(this.view(r));}
   if(request.method==="POST"&&op==="abort")return reply((await this.control("input.abort",{input_request_id:r.id})).request);
   if(request.method==="PUT"&&op==="content"){
    this.active(r);if(!r.file||Number(request.headers.get("content-length"))!==r.file.size||(r.lease??0)>this.now())throw denied();
    if(r.state==="transferred"){const body=await boundedBody(request,r.file.size);if(body.length!==r.file.size||hash(body)!==r.file.sha256)throw denied();return reply(this.view(r));}r.state="transferring";r.failure=undefined;r.lease=this.now()+600000;this.save(r);const lease=r.lease;
    const temp=join(this.dir,"pending_"+token());let fd:number|undefined;
    try{fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);const sum=createHash("sha256");let total=0;const reader=request.body?.getReader();if(!reader)throw denied();try{while(true){const {done,value}=await reader.read();if(done)break;if(request.signal.aborted||this.now()>=lease-60000)throw denied();total+=value.length;if(total>r.file.size)throw denied();sum.update(value);let at=0;while(at<value.length)at+=writeSync(fd,value,at,value.length-at)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
     const digest=sum.digest("hex");if(total!==r.file.size||(r.file.sha256&&r.file.sha256!==digest))throw denied();closeSync(fd);fd=undefined;
     const target=join(this.dir,r.id);try{linkSync(temp,target)}catch(err){if(!existsSync(target)||hash(readFileSync(target))!==digest)throw err}
     r=this.get(r.id);if(r.state!=="transferring"||r.lease!==lease)throw denied();r.state="transferred";r.file!.sha256=digest;r.failure=undefined;r.lease=undefined;this.save(r);
    }catch(error){const failure=storageError(error)??denied();r=this.get(r.id);if(r.state==="transferring"&&r.lease===lease){r.state="prepared";r.failure=failure.status>=500?failure.code:"transfer_failed";r.lease=undefined;this.save(r)}throw failure}finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))unlinkSync(temp)}
    return reply(this.view(r));
   }
   if(request.method==="POST"&&op==="complete"){
    if(r.state==="ready")return reply(this.view(r));this.active(r);if(r.state!=="transferred"||!r.file?.sha256)throw denied();const body=readFileSync(join(this.dir,r.id));if(body.length!==r.file.size||hash(body)!==r.file.sha256)throw denied();
    try{const text=new TextDecoder("utf-8",{fatal:true}).decode(body);if(text.includes("\0"))throw denied();const parsed=parseImportCsv(text);if(!parsed.items.length||parsed.badRows.length)throw denied()}catch{r.failure="verification_failed";this.save(r);throw denied()}
    r.state="ready";r.failure=undefined;r.pageHash="";this.save(r);return reply(this.view(r));
   }
   return reply({error:"method_not_allowed"},405);
  }catch(error){const failure=storageError(error)??(error instanceof InputError?error:denied());return reply({error:failure.status>=500?"Storage is unavailable; restore owner capacity and recover the original request":"Input request rejected; query or renew the original request",code:failure.code},failure.status)}
 }
}
async function boundedBody(request:Request,max:number){const reader=request.body?.getReader();if(!reader)throw denied();const pieces:Uint8Array[]=[];let total=0;try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max)throw denied();pieces.push(value)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}return Buffer.concat(pieces,total);}
