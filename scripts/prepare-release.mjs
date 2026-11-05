import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2),get=name=>{const at=args.indexOf(name);return at>=0?args[at+1]:undefined};
const os=get('--os'),notesFile=get('--notes'),version=JSON.parse(await fs.readFile(path.join(root,'package.json'))).version;
if(!['macos','windows','linux'].includes(os)||!notesFile)throw Error('Usage: npm run release:prepare -- --os macos|windows|linux --notes notes.md [--package-type deb|appimage] [--title "Release title"]');
const linuxType=get('--package-type')||'deb';if(!['deb','appimage'].includes(linuxType))throw Error('Choose --package-type deb or appimage.');
const names=await fs.readdir(path.join(root,'out/installers'));
const specifications={macos:{platform:'darwin',arch:'universal',packageType:'mac',minimumSystemVersion:'13.0.0',extension:'.dmg',filter:n=>n.includes('Universal')},windows:{platform:'win32',arch:'x64',packageType:'nsis',minimumSystemVersion:'10.0.22000',extension:'.exe',filter:()=>true},linux:{platform:'linux',arch:'x64',packageType:linuxType,extension:linuxType==='deb'?'.deb':'.AppImage',minimumSystemVersion:'5.4.0',filter:()=>true}};
const spec=specifications[os],selected=names.filter(n=>n.includes(version)&&spec.filter(n)&&(spec.extension?n.endsWith(spec.extension):n.endsWith('.deb')||n.endsWith('.AppImage')));
if(!selected.length)throw Error(`No current ${os} installer. Run npm run installers -- ${os} first. Never rename an older installer.`);
const config={version,title:get('--title')||`Mail Grid ${version}`,notes:await fs.readFile(path.resolve(notesFile),'utf8'),targets:selected.map(name=>({...spec,extension:undefined,filter:undefined,packageType:spec.packageType||(name.endsWith('.deb')?'deb':'appimage'),files:[{path:path.join(root,'out/installers',name),roles:['installer','update']}]})),output:path.join(root,`out/releases/Mail-Grid-${version}-${os}${os==='linux'?'-'+linuxType:''}-release.zip`)};
const file=path.join(root,'out',`.release-${os}-${process.pid}.json`);await fs.writeFile(file,JSON.stringify(config),{mode:0o600});
try{const run=spawnSync(process.execPath,['scripts/release-bundle.mjs',file],{cwd:root,stdio:'inherit'});if(run.status!==0)throw Error('Release assembly failed.')}finally{await fs.rm(file,{force:true})}
