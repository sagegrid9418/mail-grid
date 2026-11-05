"""Store already-compressed artifacts without recompressing them or using shell tools."""
import json
from pathlib import Path
import sys
import zipfile
spec = json.loads(Path(sys.argv[1]).read_text())
output = Path(sys.argv[2])
temporary = output.with_suffix('.partial.zip')
try:
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        archive.writestr('release.json', json.dumps(spec['envelope'], separators=(',', ':')))
        archive.writestr('verification.json', json.dumps(spec['verification'], separators=(',', ':')))
        for file in spec['files']:
            archive.write(file['path'], 'artifacts/' + file['name'])
    temporary.replace(output)
finally:
    temporary.unlink(missing_ok=True)
