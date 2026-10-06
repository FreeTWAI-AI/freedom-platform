# Exact Git source archive and restore verification

`release-source-archive.py` builds a complete source archive from an independently
selected Git commit and tree. It reads Git objects; it never runs checkout code,
package hooks, filters, or archived programs. The archive includes all tracked
regular files, including contracts, every SQL migration, historical evidence and
both dated inventory files. Working-tree edits, untracked files, `.gitignore`
and `export-ignore` do not change that set. Committed `.env` paths, symlinks and
submodules are refused, rather than silently omitted.

This is a local release/archive integrity tool. It does not install a release
workflow, approve its own source, sign a ReleaseSet, restore a database or alter
migration compatibility. **Daily `verify:inventory` remains unchanged.** The
later daily-inventory transition needs the reviewed affected selector, a real
release artifact/restore path, retained contract generation, historical migration
immutability and link checks. Current dated inventory bytes are not rewritten or
reclassified by this packet.

Use the reviewed tool on Linux with Python 3.11+ and `/usr/bin/git`. Supply the
source commit and tree from the independent release decision. The output parent
must be an existing operator-owned directory with no symlink component or group/
world write access; the output directory itself must not exist and must be outside
the source repository.

```sh
python3 scripts/release-source-archive.py build \
  --repository /operator/source \
  --source <exact-40-hex-commit> \
  --expected-tree <exact-40-hex-tree> \
  --output /operator/artifacts/release-candidate
```

The output contains `source.tar`, `inventory.json` and a last-written
`complete.json` receipt. The manifest binds source commit/tree, the tool's exact
SHA-256 and each file's path, Git mode, byte length, SHA-256 and Git blob ID. The
receipt also includes archive SHA-256. An interrupted build has no completed
receipt; ordinary errors remove only the newly owned output. Do not publish a
partially written directory. Tool identity in a manifest is provenance data,
not self-approval; obtain the tool and source pins through the existing reviewed
release path.

To verify and optionally restore, independently supply the expected source,
tree and inventory digest. A digest taken only from an untrusted archive does
not establish approval. There is no candidate-selected command or config hook.

```sh
python3 scripts/release-source-archive.py verify \
  --archive /operator/artifacts/release-candidate/source.tar \
  --inventory /operator/artifacts/release-candidate/inventory.json \
  --source <approved-commit> --expected-tree <approved-tree> \
  --expected-inventory <approved-inventory-sha256> \
  --restore-to /operator/restores/new-candidate
```

Without `--restore-to`, this checks the entire archive without writing. With it,
all canonical headers, paths, modes, content digests, padding and the complete
Git tree must pass before a new restore directory is created. The second read
checks every content digest again; writes use directory descriptors, exclusive
creation and `O_NOFOLLOW`. The restored files are read back, including their
modes, and compared with the complete inventory and source Git tree. No tar
extraction API is used. Existing targets are never overwritten; an ordinary
failed restore removes its newly owned partial directory. A killed restore can
leave a partial directory and emits no success receipt; discard that owned
partial and use a new target.

The fixed profile accepts 1–16,384 files, at most 4 MiB per file, 256 MiB total
source bytes, an 8 MiB manifest and bounded uncompressed USTAR overhead. Paths
must fit the fixed USTAR profile; unsupported extended headers, compression,
links, devices, duplicate paths, traversal, extra/missing files, noncanonical
metadata and nonzero trailing bytes fail. The trailer must be exactly the two
zero blocks plus the zero fill to the next 10,240-byte record that `build`
writes, so it is 1,024 to 10,752 bytes depending on the content offset. This intentionally is not a general
tar extractor. [Python's tar documentation](https://docs.python.org/3/library/tarfile.html)
describes the USTAR serializer used for exact header comparison.

The Git commit bytes, every blob and the reconstructed complete tree are checked
against the pinned Git identities. Local replacements, grafts, alternate object
stores and HTTP alternates are rejected. Git uses a fixed environment, no network
protocols, no hooks or lazy fetch, and bounded command output/time. This assumes
a separately controlled Git executable/object store and operator output parent;
these filesystem checks do not isolate malicious processes with the operator's
same OS identity.

Focused verification:

```sh
python3 scripts/ci/test_release_source_archive.py
```

The tests use real Git repositories and the actual CLI, then independently
recompute a restored Git tree. They cover SQL/contract tampering, missing/extra/
duplicate members, wrong source/pins, unsafe headers/paths, indirection, partial
failures, a restore directory replaced with a symlink, and real builds at all 20
512-byte offsets within a record, each checked by Python's own tar reader and
rejected with an extra, short or missing trailer. Actual Foundation
source archive/restore evidence must record both the source commit being
archived and the separate tool source/digest. It is not hosted CI or operational
backup evidence.
