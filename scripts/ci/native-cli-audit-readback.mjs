// Read-only diagnostic: never relay kernel messages, argv, environment or paths.
const MAX_BYTES=1_048_576,MAX_LINE=16_384,MAX_RECORDS=10_000;
let bytes=0,records=0,matches=0,pending='',bounded=true;
function accept(line){
 if(++records>MAX_RECORDS||Buffer.byteLength(line)>MAX_LINE){bounded=false;return;}
 try{
  const value=JSON.parse(line),message=value.MESSAGE;
  if(typeof message!=='string')return;
  const fields=new Map();
  for(const found of message.matchAll(/(?:^|\s)(apparmor|operation|info|error|profile)=(?:"([^"]*)"|([^\s]+))/g)){
   if(fields.has(found[1]))return;fields.set(found[1],found[2]??found[3]);
  }
  if(fields.get('apparmor')==='DENIED'&&fields.get('operation')==='exec'&&
   fields.get('info')==='Failed name lookup - deleted entry'&&fields.get('error')==='-2'&&
   ['bwrap','unpriv_bwrap'].includes(fields.get('profile')))matches++;
 }catch{/* Unknown/malformed records cannot become audit evidence. */}
}
for await(const chunk of process.stdin){
 bytes+=chunk.length;if(bytes>MAX_BYTES){bounded=false;continue;}
 pending+=chunk.toString('utf8');let newline;
 while((newline=pending.indexOf('\n'))!==-1){accept(pending.slice(0,newline));pending=pending.slice(newline+1);}
 if(Buffer.byteLength(pending)>MAX_LINE){bounded=false;pending='';}
}
if(pending&&bounded)accept(pending);
console.log(JSON.stringify({schema:'freedom.native-cli-audit-readback/v1',bounded,
 matched_denials:matches,apparmor_exec_deleted_entry_enoent_bwrap:matches>0,
 raw_kernel_messages_emitted:false,read_only:true,policy_changed:false}));
