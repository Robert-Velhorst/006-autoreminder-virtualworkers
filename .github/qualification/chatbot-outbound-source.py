"""Bind hosted exact-source outbound policy cases to every tracked Git payload."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys

assert os.environ.get('GITHUB_ACTIONS') == 'true'
assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
assert os.environ.get('GITHUB_REPOSITORY') == 'Robert-Velhorst/006-autoreminder-virtualworkers'
phase, = sys.argv[1:]
assert phase in {'before', 'after'}
out = Path(os.environ['RUNNER_TEMP']).resolve() / 'va-chatbot-outbound-boundary'
out.mkdir(exist_ok=True)
records = {}
for row in subprocess.check_output(['git', 'ls-tree', '-r', '-z', 'HEAD']).split(b'\0'):
    if not row:
        continue
    meta, encoded = row.split(b'\t', 1)
    mode, kind, blob = meta.decode().split()
    name = encoded.decode()
    assert kind == 'blob' and mode in {'100644', '100755'}
    source = Path(name)
    assert not source.is_symlink() and source.resolve().is_relative_to(Path.cwd().resolve())
    raw = source.read_bytes()
    assert hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == blob, name
    records[name] = {'mode': mode, 'blob': blob, 'sha256': hashlib.sha256(raw).hexdigest()}
head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
assert head == os.environ['GITHUB_SHA']
data = {'head': head, 'tree': subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}']).decode().strip(), 'files': records}
if phase == 'after':
    assert data == json.loads((out / 'source-before.json').read_bytes())
(out / ('source-' + phase + '.json')).write_text(json.dumps(data, indent=2) + '\n')
print(json.dumps({'phase': phase, 'source_payloads': len(records)}))
