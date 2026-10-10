// Derived delivery ZIP: stored entries, streaming SHA/CRC, ZIP64 for large packages.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {releaseZipEntries} from './release-zip.mjs';
const active=new Map();
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const u16=(b,o,n)=>b.writeUInt16LE(n,o),u32=(b,o,n)=>b.writeUInt32LE(n>>>0,o),u64=(b,o,n)=>b.writeBigUInt64LE(BigInt(n),o);
export async function deliveryBundle(dataDir,release,artifacts,extraFiles=[]) {
 const entries=artifacts.map(a=>{if(!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.size)||a.size<1||['.','..','安装说明.txt'].includes(a.file)||a.file.includes(':')||path.basename(a.file)!==a.file||/[\\\x00-\x1f]/.test(a.file))throw Error('制品文件信息不合法');return a;});
 if(new Set(entries.map(a=>a.file)).size!==entries.length)throw Error('制品文件名重复');
 const extras=extraFiles.map(e=>{if(!/^升级SQL\/(mysql|postgresql)-(bms|etl)\.sql$/.test(e.file)||typeof e.content!=='string'||Buffer.byteLength(e.content)>20*1024*1024)throw Error('累计SQL附件不合法');const bytes=Buffer.from(e.content);return {file:e.file,size:bytes.length,bytes};});
 if(new Set(extras.map(e=>e.file)).size!==extras.length)throw Error('累计SQL附件重复');
 const key=hash(JSON.stringify({format:4,release,entries:entries.map(a=>[a.file,a.sha256,a.size]),extras:extras.map(e=>[e.file,hash(e.bytes)])}));const dir=path.join(dataDir,'release-bundles'),dest=path.join(dir,key+'.zip');fs.mkdirSync(dir,{recursive:true});
 if(active.has(dest))return active.get(dest);
 if(fs.existsSync(dest)){try{const st=fs.statSync(dest),meta=JSON.parse(fs.readFileSync(dest+'.json'));if(meta.key===key&&meta.size===st.size&&meta.mtimeMs===st.mtimeMs&&/^[a-f0-9]{64}$/.test(meta.sha256))return {file:dest,size:st.size};}catch{}fs.rmSync(dest,{force:true});fs.rmSync(dest+'.json',{force:true});}
 const job=(async()=>{const temp=dest+'.'+crypto.randomUUID()+'.tmp';let out;try{out=await fs.promises.open(temp,'wx',0o600);let offset=0;const central=[],archiveHash=crypto.createHash('sha256');const write=async b=>{await out.writeFile(b);archiveHash.update(b);offset+=b.length;};
 const program=[];for(const a of entries)program.push(...await releaseZipEntries(path.join(dataDir,'release-artifacts',a.sha256),a));
 const names=new Set();for(const e of program){const key=e.file.normalize('NFC').toLowerCase();if(names.has(key))throw Error('程序文件路径冲突');names.add(key);}
 for(const e of program){const parts=e.file.split('/');for(let i=1;i<parts.length;i++)if(names.has(parts.slice(0,i).join('/').normalize('NFC').toLowerCase()))throw Error('程序文件目录冲突');}
 const sources=[{file:'升级SQL/',size:0,bytes:Buffer.alloc(0)},{file:'程序文件/',size:0,bytes:Buffer.alloc(0)},...program,...extras];
 for(const entry of sources){const start=offset,name=Buffer.from(entry.file),head=Buffer.alloc(30),extra=Buffer.alloc(20);u32(head,0,0x04034b50);u16(head,4,45);u16(head,6,0x808);u32(head,18,0xffffffff);u32(head,22,0xffffffff);u16(head,26,name.length);u16(head,28,20);u16(extra,0,1);u16(extra,2,16);u64(extra,4,entry.size);u64(extra,12,entry.size);await write(head);await write(name);await write(extra);
 let crc=0xffffffff,size=0;const sha=crypto.createHash('sha256');for await(const chunk of entry.bytes?[entry.bytes]:entry.stream()){size+=chunk.length;if(size>entry.size)throw Error('ZIP解压长度不匹配');sha.update(chunk);for(const byte of chunk)crc=table[(crc^byte)&255]^(crc>>>8);await write(chunk);}crc=(crc^0xffffffff)>>>0;if(size!==entry.size||(entry.crc!==undefined&&crc!==entry.crc)||(entry.sha256&&sha.digest('hex')!==entry.sha256))throw Error('制品完整性校验失败');
 const descriptor=Buffer.alloc(24);u32(descriptor,0,0x08074b50);u32(descriptor,4,crc);u64(descriptor,8,size);u64(descriptor,16,size);await write(descriptor);
 const c=Buffer.alloc(46),e=Buffer.alloc(28);u32(c,0,0x02014b50);u16(c,4,45);u16(c,6,45);u16(c,8,0x808);u32(c,16,crc);u32(c,20,0xffffffff);u32(c,24,0xffffffff);u16(c,28,name.length);u16(c,30,28);u32(c,42,0xffffffff);u16(e,0,1);u16(e,2,24);u64(e,4,size);u64(e,12,size);u64(e,20,start);central.push(Buffer.concat([c,name,e]));}
 const centralStart=offset;for(const c of central)await write(c);const centralSize=offset-centralStart,zip64Start=offset;const end64=Buffer.alloc(56);u32(end64,0,0x06064b50);u64(end64,4,44);u16(end64,12,45);u16(end64,14,45);u64(end64,24,sources.length);u64(end64,32,sources.length);u64(end64,40,centralSize);u64(end64,48,centralStart);await write(end64);const locator=Buffer.alloc(20);u32(locator,0,0x07064b50);u64(locator,8,zip64Start);u32(locator,16,1);await write(locator);const end=Buffer.alloc(22);u32(end,0,0x06054b50);u16(end,8,0xffff);u16(end,10,0xffff);u32(end,12,0xffffffff);u32(end,16,0xffffffff);await write(end);await out.sync();await out.close();out=null;await fs.promises.rename(temp,dest);const meta={key,size:offset,mtimeMs:fs.statSync(dest).mtimeMs,sha256:archiveHash.digest('hex')};await fs.promises.writeFile(temp+'.json',JSON.stringify(meta),{mode:0o600});await fs.promises.rename(temp+'.json',dest+'.json');return {file:dest,size:offset};
 }finally{await out?.close();await fs.promises.rm(temp,{force:true});await fs.promises.rm(temp+'.json',{force:true});}})();active.set(dest,job);try{return await job;}finally{active.delete(dest);}
}
