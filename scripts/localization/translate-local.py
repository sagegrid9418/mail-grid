"""Local-only maintainer utility: no HTTP client, remote API or runtime dependency.
Requires CTranslate2 and SentencePiece in a temporary Python environment.
Model: gn64/M2M100_418M_CTranslate2 @ 18e406c615ef2991fa74d53734bf66b0a6b10cb4
Derived from facebook/m2m100_418M, MIT. Inputs and outputs stay on this computer.
"""
import pathlib,json,re,sys,subprocess,unicodedata,time
import numpy
import ctranslate2,sentencepiece
import concurrent.futures
root=pathlib.Path(__file__).resolve().parents[2];directory=root/'assets/locales'
english=json.loads((directory/'en.json').read_text());allow=json.loads((root/'scripts/localization/unchanged.json').read_text())['global']
languages=['ar','de','es','fa','fr','ha','he','hi','id','ig','it','ja','ko','nl','pl','pt','ru','sw','uk','yo','zh']
translator=ctranslate2.Translator(sys.argv[1],device='cpu',compute_type='int8',inter_threads=2,intra_threads=1)
sp=sentencepiece.SentencePieceProcessor(model_file=sys.argv[2]);failures=[]
# Protect interpolation and literal developer identifiers with ordinary number tokens.
pattern=r'\{\w+\}|Mail Grid|MAIL GRID|mail-dev\.sagegrid\.org|127\.0\.0\.1|SMTP|IMAP|POP3|HTML|HTTP(?:S)?|Laravel|Thunderbird|Docker|WSL|\.env|Privacy & Security|Focus / Do Not Disturb|MB'
def protect(text):
 tokens={}
 def replace(match):
  number=str(8751+len(tokens));tokens[number]=match.group(0);return number
 return re.sub(pattern,replace,text),tokens
def translate(texts,language):
 inputs=[protect(t) for t in texts];tokens=[['__en__']+sp.encode(t,out_type=str)+['</s>'] for t,_ in inputs]
 results=translator.translate_batch(tokens,target_prefix=[['__'+language+'__'] for _ in tokens],beam_size=1,max_decoding_length=min(300,max(len(t) for t in tokens)*3+20),max_batch_size=16)
 output=[]
 for source,result,(_,mapping) in zip(texts,results,inputs):
  value=sp.decode(result.hypotheses[0][1:]).strip();value=''.join(str(unicodedata.digit(c)) if c.isdecimal() else c for c in value)
  valid=True
  for number,original in mapping.items():
   regex=r'[\s,.٬،]*'.join(number)
   value,n=re.subn(regex,lambda _:original,value)
   if n!=1:valid=False
  if not valid or sorted(re.findall(r'\{\w+\}',value))!=sorted(re.findall(r'\{\w+\}',source)) or not value:
   output.append(None);failures.append({'language':language,'source':source,'candidate':value})
  else: output.append(value)
 return output
for language in languages:
 file=directory/(language+'.json');catalog=json.loads(file.read_text())
 for key in allow:
  if key in english:catalog[key]=key
 missing=sorted([key for key in english if not catalog.get(key)],key=len)
 chunks=[missing[at:at+16] for at in range(0,len(missing),16)]
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
  results=executor.map(lambda keys:translate(keys,language),chunks)
  for at,(keys,values) in enumerate(zip(chunks,results)):
   for key,value in zip(keys,values):
    if value:catalog[key]=value
   file.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
   print(language,min((at+1)*16,len(missing)),'/',len(missing),flush=True)
 print('CATALOG',language,'complete',len([k for k in english if catalog.get(k)]),'/',len(english),flush=True)
 (root/'scripts/localization/review-local.json').write_text(json.dumps(failures,ensure_ascii=False,indent=2)+'\n')
# ICU's deterministic script conversion supplies the Traditional Chinese catalog.
zh=(directory/'zh.json').read_text();converted=subprocess.run(['/Applications/XAMPP/bin/uconv','-x','Simplified-Traditional'],input=zh,text=True,stdout=subprocess.PIPE,check=True).stdout
(directory/'zh-Hant.json').write_text(converted)
print('Local generation finished. Review token failures and unchanged-English entries before enabling a catalog.',flush=True)
