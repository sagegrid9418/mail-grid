"""Inspect the current universal DMG without installing or registering its app."""
import hashlib,json,os,plistlib,subprocess,tempfile
from pathlib import Path
from installers import check_current_bundle
ROOT=Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT/'package.json').read_text())['version']
DMG=ROOT/'out/installers'/f'Mail-Grid-{VERSION}-macOS-Universal.dmg'
GO=os.environ.get('MAILGRID_GO','go')
def run(args,**kwargs):
 return subprocess.check_output([str(x) for x in args],stderr=subprocess.PIPE,**kwargs)
run(['/usr/bin/hdiutil','verify',DMG])
with tempfile.TemporaryDirectory(prefix='mailgrid-dmg-payload-') as directory:
 temp=Path(directory);mount=temp/'mounted';mount.mkdir()
 run(['/usr/bin/hdiutil','attach','-readonly','-nobrowse','-mountpoint',mount,DMG])
 try:
  app=mount/'Mail Grid.app';resources=app/'Contents/Resources'
  info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
  assert info['CFBundleIdentifier']=='dev.mailgrid.app' and info['CFBundleShortVersionString']==VERSION and info['CFBundleExecutable']=='Mail Grid'
  run(['/usr/bin/codesign','--verify','--deep','--strict',app])
  count=0
  for file in app.rglob('*'):
   if not file.is_file() or file.is_symlink():continue
   with file.open('rb') as stream:magic=stream.read(4).hex()
   if magic in ['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','cafebabf','bebafeca','bfbafeca']:
    architectures=run(['/usr/bin/lipo','-archs',file],text=True).split()
    assert 'x86_64' in architectures and 'arm64' in architectures,f'Non-universal Mach-O: {file.relative_to(app)}'
    count+=1
  assert count>=10
  check_current_bundle(resources/'app.asar')
  assert json.loads((resources/'app-update.yml').read_text())['url']=='https://mail-dev.sagegrid.org'
  # Compare source build IDs after stripping the fat wrapper. Ad-hoc signing
  # changes signature bytes, but preserves Go's source-derived build identity.
  trust=(ROOT/'assets/update-trust.json').read_bytes()
  import base64
  for architecture,go_arch in [('x86_64','amd64'),('arm64','arm64')]:
   for name,package in [('mailgrid-engine','.'),('mailgrid-updater','./cmd/mailgrid-updater')]:
    expected=temp/f'expected-{name}-{go_arch}'
    args=[GO,'build','-trimpath','-o',expected]
    if name=='mailgrid-updater':args+=['-ldflags','-X main.trustBase64='+base64.b64encode(trust).decode()]
    args+=[package]
    run(args,cwd=ROOT/'engine',env={**os.environ,'GOOS':'darwin','GOARCH':go_arch,'CGO_ENABLED':'0'})
    actual=temp/f'actual-{name}-{go_arch}';run(['/usr/bin/lipo',resources/name,'-thin',architecture,'-output',actual])
    assert run([GO,'tool','buildid',actual])==run([GO,'tool','buildid',expected]),f'Stale Go code/trust: {name}/{go_arch}'
  print(f'PASS: final DMG integrity, {count} universal Mach-O files, valid ad-hoc app signature, current version/UI/main/catalogs/public key, updater configuration and source build identities for both engine/helper architectures. No installation performed.')
 finally:run(['/usr/bin/hdiutil','detach',mount])
