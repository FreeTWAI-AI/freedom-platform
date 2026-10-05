"""Read a bounded Docker archive without extracting or following any links.

This trusted host program emits names/hashes only. Candidate files remain data.
"""
import hashlib
import io
import json
import re
import sys
import tarfile

LIMIT = 8 * 1024 * 1024


def summarize(raw):
    if not raw or len(raw) > LIMIT:
        raise ValueError('archive_size')
    files, directories, seen, total = [], [], set(), 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        for member in archive:
            name = member.name.rstrip('/') if member.isdir() else member.name
            if (len(seen) >= 1024 or name in seen or len(name) > 512
                    or not re.fullmatch(r'work(?:/[A-Za-z0-9_.-]+)*', name)
                    or any(part in ('.', '..') for part in name.split('/'))
                    or not (member.isfile() or member.isdir())
                    or member.linkname or member.sparse is not None):
                raise ValueError('archive_entry')
            seen.add(name)
            if member.isdir():
                if member.size:
                    raise ValueError('directory_bytes')
                directories.append(name)
            else:
                total += member.size
                if member.size < 0 or member.size > 2 * 1024 * 1024 or total > 4 * 1024 * 1024:
                    raise ValueError('file_size')
                content = archive.extractfile(member).read(member.size + 1)
                if len(content) != member.size:
                    raise ValueError('truncated_file')
                files.append([name, hashlib.sha256(content).hexdigest()])
    if not files or 'work' not in directories:
        raise ValueError('missing_tree')
    return {'files': sorted(files), 'directories': sorted(directories)}


if __name__ == '__main__':
    try:
        print(json.dumps(summarize(sys.stdin.buffer.read(LIMIT + 1))))
    except Exception:
        print('{"error":"directory_archive_invalid"}')
        sys.exit(1)
