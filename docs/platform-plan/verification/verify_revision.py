"""Verify distributed file bytes and local Markdown file links; no network or writes."""
from pathlib import Path
import hashlib
import json
import os
import re
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "docs/platform-plan/verification/2026-09-20-file-inventory.json"
IGNORE = {".git", ".gitdata", ".venv", "venv", "__pycache__", ".pytest_cache", ".DS_Store", "__MACOSX", "node_modules", "dist", "test-results", "playwright-report"}

def source_files():
    """Shared archive inventory boundary; never traverse installed/build artifacts."""
    for directory, dirs, names in os.walk(ROOT):
        dirs[:] = sorted(d for d in dirs if d not in IGNORE)
        for name in sorted(names):
            if name in IGNORE or name.endswith((".pyc", ".pyo", ".log")):
                continue
            if (name == ".env" or name.startswith(".env.")) and name != ".env.example":
                continue
            path = Path(directory) / name
            if path != MANIFEST:
                yield path

def main():
    manifest = json.loads(MANIFEST.read_text())
    failures = []
    listed = {e["path"] for e in manifest["files"]}
    files = list(source_files())
    actual = {str(p.relative_to(ROOT)) for p in files}
    if actual != listed:
        failures.append(f"File set changed: extra={sorted(actual-listed)}, missing={sorted(listed-actual)}")
    for entry in manifest["files"]:
        path = ROOT / entry["path"]
        if not path.is_file():
            continue
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["sha256"] or len(data) != entry["bytes"]:
            failures.append(f"Byte or digest mismatch: {entry['path']}")
    links = 0
    for path in files:
        if path.suffix != ".md":
            continue
        for raw in re.findall(r"(?<!!)\[[^\]\n]*\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)", path.read_text()):
            target = raw.split("#", 1)[0]
            if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("/"):
                continue
            links += 1
            if not (path.parent / unquote(target)).exists():
                failures.append(f"Missing relative link in {path.relative_to(ROOT)}: {raw}")
    for failure in failures:
        print("FAIL:", failure)
    print(f"{len(manifest['files'])} file hashes; {links} local file/directory links; {len(failures)} failures")
    print("Markdown section anchors, external URLs, product runtime, signatures and real-user evidence are NOT verified.")
    return bool(failures)

if __name__ == "__main__":
    sys.exit(main())
