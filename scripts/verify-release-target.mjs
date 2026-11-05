import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node scripts/verify-release-target.mjs target-input.json target-result.json');
const target=JSON.parse(await fs.readFile(input,'utf8'));const id=`${target.platform}/${target.arch}/${target.packageType}`;
if(process.platform!==target.platform||!['darwin/x64/mac','darwin/arm64/mac','darwin/universal/mac','win32/x64/nsis','linux/x64/appimage','linux/x64/deb'].includes(id))throw Error('Verify each target on its native operating system.');
if(process.env.MAILGRID_NATIVE_SMOKE_PASSED!=='1'||!process.env.MAILGRID_NATIVE_SMOKE_LOG)throw Error('Run the native install/upgrade smoke test first and supply its passing log.');
const log=await fs.readFile(process.env.MAILGRID_NATIVE_SMOKE_LOG);if(log.length<20)throw Error('Smoke-test log is empty or incomplete.');
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;if(target.version!==version)throw Error('Target version differs from the source version.');
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const digest=file=>new Promise((resolve,reject)=>{const hash=crypto.createHash('sha256');createReadStream(file).on('data',chunk=>hash.update(chunk)).on('end',()=>resolve(hash.digest('hex'))).on('error',reject)});
async function verifyMacApp(app){
 run('/usr/bin/codesign',['--verify','--deep','--strict',app]);if(process.env.MAILGRID_VERIFY_PLATFORM_SIGNING==='1'){run('/usr/sbin/spctl',['--assess','--type','execute',app]);run('/usr/bin/xcrun',['stapler','validate',app]);}
 const executable=run('/usr/bin/plutil',['-extract','CFBundleExecutable','raw','-o','-',path.join(app,'Contents/Info.plist')]).trim();
 for(const file of [path.join(app,'Contents/MacOS',executable),path.join(app,'Contents/Resources/mailgrid-engine'),path.join(app,'Contents/Resources/mailgrid-updater')]){const architectures=run('/usr/bin/lipo',['-archs',file]).trim().split(/\s+/);if(!(target.arch==='universal'?['x86_64','arm64']:[target.arch==='x64'?'x86_64':'arm64']).every(arch=>architectures.includes(arch)))throw Error('Mac artifact architecture mismatch.');}
 const actual=run('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',path.join(app,'Contents/Info.plist')]).trim();if(actual!==version)throw Error('Mac application version mismatch.');
}
if(target.platform==='darwin'){
 if(!target.appPath)throw Error('Specify the built appPath.');await verifyMacApp(path.resolve(target.appPath));
 for(const file of target.files){
  if(file.path.endsWith('.zip')){const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mailgrid-verify-'));try{run('/usr/bin/ditto',['-x','-k',file.path,temp]);const app=(await fs.readdir(temp)).find(name=>name.endsWith('.app'));if(!app)throw Error('ZIP has no Mac app.');await verifyMacApp(path.join(temp,app));}finally{await fs.rm(temp,{recursive:true,force:true});}}
  else if(file.path.endsWith('.dmg')){
   run('/usr/bin/hdiutil',['verify',file.path]);
   const attached=run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-plist',file.path]);
   const info=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:attached,encoding:'utf8'}));
   const mounts=info['system-entities'].map(entry=>entry['mount-point']).filter(Boolean);
   try{let found=false;for(const mount of mounts){for(const name of await fs.readdir(mount)){if(name.endsWith('.app')){found=true;await verifyMacApp(path.join(mount,name));}}}if(!found)throw Error('DMG has no signed Mail Grid application.');}
   finally{for(const mount of mounts)run('/usr/bin/hdiutil',['detach',mount]);}
  }
 }
}else if(target.platform==='win32'&&process.env.MAILGRID_VERIFY_PLATFORM_SIGNING==='1'){
 for(const file of target.files){const quoted=path.resolve(file.path).replaceAll("'","''");const program=`$s=Get-AuthenticodeSignature -LiteralPath '${quoted}'; if($s.Status -ne 'Valid'){exit 2}; $p=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false); if($p -ne '${(process.env.MAILGRID_WINDOWS_PUBLISHER||'').replaceAll("'","''")}'){exit 3}`;run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(program,'utf16le').toString('base64')]);}
}else if(target.platform==='linux'){
 for(const file of target.files){if(file.path.endsWith('.deb')){if(run('dpkg-deb',['-f',file.path,'Architecture']).trim()!=='amd64')throw Error('DEB architecture mismatch.');}else if(!run('file',[file.path]).includes('x86-64'))throw Error('AppImage architecture mismatch.');}
}
const files={};for(const file of target.files)files[path.basename(file.path)]=await digest(file.path);
await fs.writeFile(output,JSON.stringify({version,profile:'verified',targets:{[id]:{passed:true,files,smokeLogSha256:crypto.createHash('sha256').update(log).digest('hex')}}},null,2)+'\n');
console.log('Verified native target:',id);
