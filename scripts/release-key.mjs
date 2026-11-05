import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const directory=path.join(root,'.release-private'), privateFile=path.join(directory,'release-key.pem'), trustFile=path.join(root,'assets/update-trust.json');
fs.mkdirSync(directory,{recursive:true,mode:0o700});
if(!fs.existsSync(privateFile)){
 const {privateKey}=crypto.generateKeyPairSync('ed25519');
 fs.writeFileSync(privateFile,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
}
const key=crypto.createPrivateKey(fs.readFileSync(privateFile));
if(key.asymmetricKeyType!=='ed25519')throw Error('The existing release key is not Ed25519.');
const publicKey=crypto.createPublicKey(key).export({type:'spki',format:'pem'});
const trust=JSON.parse(fs.readFileSync(trustFile,'utf8'));
if(!trust.publicKeys.includes(publicKey))fs.writeFileSync(trustFile,JSON.stringify({publicKeys:[...trust.publicKeys,publicKey]},null,2)+'\n');
console.log('Free release key ready. Back up .release-private securely; never upload it to hosting or share it.');
