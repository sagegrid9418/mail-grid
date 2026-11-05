import fs from 'node:fs/promises';
const [output,...files]=process.argv.slice(2);if(!output||files.length<1)throw Error('Supply an output path and one or more native verification result files.');
const result={version:'',profile:'verified',targets:{}};
for(const file of files){const value=JSON.parse(await fs.readFile(file,'utf8'));if(!['production','verified'].includes(value.profile)||(result.version&&result.version!==value.version))throw Error('Verification versions/profiles differ.');result.version=value.version;for(const [id,target]of Object.entries(value.targets)){if(result.targets[id]||!target.passed)throw Error('Duplicate or failed native target.');result.targets[id]=target;}}
await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');console.log('Merged the supplied native target verification records.');
