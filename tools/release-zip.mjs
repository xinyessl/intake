// Read immutable release ZIPs without extracting paths to disk or buffering payloads.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createInflateRaw} from 'node:zlib';
const number=n=>{const v=Number(n);if(!Number.isSafeInteger(v)||v<0)throw Error('ZIP范围不合法');return v;};
export async function releaseZipEntries(file,artifact){
 const st=await fs.promises.stat(file);if(st.size!==artifact.size)throw Error('制品完整性校验失败');
 const sha=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))sha.update(b);if(sha.digest('hex')!==artifact.sha256)throw Error('制品完整性校验失败');
 const f=await fs.promises.open(file,'r');
 try{
 const read=async(pos,len)=>{if(pos<0||len<0||pos+len>st.size)throw Error('ZIP范围不合法');const b=Buffer.alloc(len);const r=await f.read(b,0,len,pos);if(r.bytesRead!==len)throw Error('ZIP截断');return b;};
 const tail=await read(Math.max(0,st.size-65557),Math.min(st.size,65557));let end=-1;for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}if(end<0)throw Error('ZIP结束记录缺失');
 if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6))throw Error('不支持分卷ZIP');
 let count=tail.readUInt16LE(end+10),size=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
 if(count===65535||size===0xffffffff||offset===0xffffffff){const loc=await read(st.size-tail.length+end-20,20);if(loc.readUInt32LE(0)!==0x07064b50||loc.readUInt32LE(4)!==0||loc.readUInt32LE(16)!==1)throw Error('ZIP64定位不合法');const z=await read(number(loc.readBigUInt64LE(8)),56);if(z.readUInt32LE(0)!==0x06064b50||z.readUInt32LE(16)||z.readUInt32LE(20))throw Error('ZIP64不合法');count=number(z.readBigUInt64LE(32));size=number(z.readBigUInt64LE(40));offset=number(z.readBigUInt64LE(48));}
 if(count>100000||size>64*1024*1024)throw Error('ZIP目录过大');const cd=await read(offset,size),result=[],seen=new Set();let p=0,total=0;
 for(let i=0;i<count;i++){
 if(p+46>cd.length||cd.readUInt32LE(p)!==0x02014b50)throw Error('ZIP目录不合法');const flags=cd.readUInt16LE(p+8),method=cd.readUInt16LE(p+10),crc=cd.readUInt32LE(p+16),nl=cd.readUInt16LE(p+28),el=cd.readUInt16LE(p+30),cl=cd.readUInt16LE(p+32);let compressed=cd.readUInt32LE(p+20),plain=cd.readUInt32LE(p+24),local=cd.readUInt32LE(p+42);if(p+46+nl+el+cl>cd.length)throw Error('ZIP目录截断');
 const name=new TextDecoder('utf-8',{fatal:true}).decode(cd.subarray(p+46,p+46+nl));const mode=cd.readUInt32LE(p+38)>>>16;
 if(flags&1||![0,8].includes(method))throw Error('ZIP加密或压缩方式不支持');if((mode&0xf000)&&![0x8000,0x4000].includes(mode&0xf000))throw Error('ZIP不允许链接或特殊文件');
 if(!name||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/')||name.split('/').some((v,j,a)=>v==='.'||v==='..'||(!v&&j!==a.length-1)))throw Error('ZIP路径不合法');if(seen.has(name))throw Error('ZIP路径重复');seen.add(name);
 for(let ep=p+46+nl;ep<p+46+nl+el;){if(ep+4>p+46+nl+el)throw Error('ZIP扩展截断');const id=cd.readUInt16LE(ep),len=cd.readUInt16LE(ep+2);if(ep+4+len>p+46+nl+el)throw Error('ZIP扩展截断');if(id===1){let q=ep+4;const take=()=>{if(q+8>ep+4+len)throw Error('ZIP64扩展截断');const v=number(cd.readBigUInt64LE(q));q+=8;return v;};if(plain===0xffffffff)plain=take();if(compressed===0xffffffff)compressed=take();if(local===0xffffffff)local=take();}ep+=4+len;}
 p+=46+nl+el+cl;if(name.endsWith('/'))continue;
 const head=await read(local,30);if(head.readUInt32LE(0)!==0x04034b50||head.readUInt16LE(8)!==method||head.readUInt16LE(6)!==flags)throw Error('ZIP文件头不一致');const localName=await read(local+30,head.readUInt16LE(26));if(!localName.equals(Buffer.from(name)))throw Error('ZIP路径不一致');const start=local+30+head.readUInt16LE(26)+head.readUInt16LE(28);if(start+compressed>offset)throw Error('ZIP数据范围不合法');
 total+=plain;if(total>16*1024**3)throw Error('ZIP解压容量超限');
 if(!/^(apps|web)\//.test(name))continue;
 if(/\.sql$/i.test(name))throw Error('程序目录不允许重复SQL');
 let delivered=name.replace(/^(apps\/[^/]+)\/internal-lib\//,'$1/lib/');
 const main=name.match(/^apps\/([^/]+)\/([^/]+\.jar)$/i);
 if(main){const [,module,jar]=main;if(!/^[a-z][a-z0-9-]*$/.test(module)||!(jar===module+'.jar'||(jar.startsWith(module+'-')&&/^\d[0-9A-Za-z._-]*\.jar$/.test(jar.slice(module.length+1)))))throw Error('业务JAR名称不符合模块启动契约');delivered='apps/'+module+'/'+module+'.jar';}

 result.push({file:'程序文件/'+delivered,size:plain,crc,stream:async function*(){if(!compressed)return;const stream=fs.createReadStream(file,{start,end:start+compressed-1}),inflate=method===8?createInflateRaw():null;try{if(inflate)stream.on('error',e=>inflate.destroy(e));for await(const chunk of inflate?stream.pipe(inflate):stream)yield chunk;}finally{stream.destroy();inflate?.destroy();}}});
 }
 if(p!==cd.length||!result.length)throw Error('ZIP缺少程序文件或目录不完整');return result;
 }finally{await f.close();}
}
