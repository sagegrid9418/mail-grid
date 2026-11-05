import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
export function collectMessages(root){
 const messages=new Set(['Inbox','INBOX','Sent','Trash','Accounts','SMTP port','IMAP port','POP3 port','Mail host','Content','Account password','Username','Copy','Quit','Open Mail Grid','Laravel configuration','Could not complete this action. Diagnostic details:','Startup is available in the installed app.','The server does not support resuming. Download restarted safely.']);
 function collect(value){if(!value)return;if(ts.isStringLiteral(value)||ts.isNoSubstitutionTemplateLiteral(value)){if(value.text.trim())messages.add(value.text.trim())}else if(ts.isConditionalExpression(value)){collect(value.whenTrue);collect(value.whenFalse)}}
 for(const folder of ['src','desktop'])for(const name of fs.readdirSync(path.join(root,folder)).filter(n=>/\.(tsx?|jsx?)$/.test(n))){const file=path.join(root,folder,name),source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true,name.endsWith('tsx')?4:3);function visit(node){if(ts.isPropertyAssignment(node)&&ts.isIdentifier(node.name)&&['error','unsupportedReason'].includes(node.name.text))collect(node.initializer);if(ts.isStringLiteral(node)&&/\{\w+\}/.test(node.text)&&!node.text.includes('MAIL_FROM_NAME'))collect(node);if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['t','translate','Error'].includes(node.expression.text))collect(node.arguments[0]);if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&/Error$/.test(node.expression.text))collect(node.arguments?.[0]);ts.forEachChild(node,visit)}visit(source)}
 for(const name of fs.readdirSync(path.join(root,'engine')).filter(n=>n.endsWith('.go')&&!n.endsWith('_test.go'))){const source=fs.readFileSync(path.join(root,'engine',name),'utf8');for(const match of source.matchAll(/errors.New\("([^"\n]+)"\)/g))messages.add(match[1]);}
 return Object.fromEntries([...messages].sort().map(x=>[x,x]));
}
