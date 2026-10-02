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
for path in sorted(inventory.source_files(), key=lambda item: item.relative_to(root).as_posix()):
    data = path.read_bytes()
    files.append({"path": path.relative_to(root).as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
inventory.MANIFEST.write_text(json.dumps({
    "version": json.loads((root / "package.json").read_text(encoding="utf-8"))["version"],
    "scope": "source files, including historical evidence; excludes self, secrets, dependencies, build and test artifacts",
    "files": files,
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
print(f"Wrote {len(files)} file hashes to {inventory.MANIFEST.relative_to(root)}")
