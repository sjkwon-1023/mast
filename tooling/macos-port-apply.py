"""One-shot transport for the reviewed development patch; removed after use."""
import base64
import hashlib
import lzma
from pathlib import Path
import subprocess

parts = [Path(f'tooling/macos-port-part-{i}.txt') for i in range(1, 5)]
encoded = ''.join(p.read_text().strip() for p in parts)
patch = lzma.decompress(base64.b64decode(encoded, validate=True))
assert hashlib.sha256(patch).hexdigest() == '134a6344891c0a1ccd8e721137ee6f7b3ea19aa99c63d6201e1e6f693b68047d', 'Patch transport checksum mismatch'
subprocess.run(['git', 'apply', '--check', '--unidiff-zero', '-'], input=patch, check=True)
subprocess.run(['git', 'apply', '--unidiff-zero', '-'], input=patch, check=True)
for part in parts:
    part.unlink()
print('Applied verified macOS implementation patch')
