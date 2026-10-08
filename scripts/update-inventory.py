"""Rebuild the current local milestone manifest; historical manifests stay immutable."""
import hashlib
import importlib.util
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("inventory", root / "docs/platform-plan/verification/verify_revision.py")
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
files = []
# source_files() already walks in a fixed order (each directory's files, then its sorted subdirectories); sorting the
# Path objects again would reorder the whole manifest against what main holds and turn every merge into a conflict.
for path in inventory.source_files():
    data = path.read_bytes()
    files.append({"path": str(path.relative_to(root)), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
inventory.MANIFEST.write_text(json.dumps({
    "version": json.loads((root / "package.json").read_text())["version"],
    "scope": "source files, including historical evidence; excludes self, secrets, dependencies, build and test artifacts",
    "files": files,
}, ensure_ascii=False, indent=2) + "\n")
print(f"Wrote {len(files)} file hashes to {inventory.MANIFEST.relative_to(root)}")
