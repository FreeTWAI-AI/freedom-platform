"""Trusted daily Git/link/migration checks; complete byte inventories belong to releases."""
import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
from urllib.parse import unquote

spec = importlib.util.spec_from_file_location('source_archive', Path(__file__).resolve().parents[1] / 'release-source-archive.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
LINK = re.compile(r'(?<!!)\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)')


def catalog(repository, commit):
    archive.require(archive.HEX40.fullmatch(commit), 'source_commit_required')
    tree = archive.git(repository, ['rev-parse', '--verify', commit + '^{tree}']).decode().strip()
    entries = archive.source_catalog(repository, commit, tree)
    return tree, {entry['path']: entry for entry in entries}


def verify(repository, base, candidate, event, head=None):
    archive.require(event in ['pull_request', 'push', 'merge_group'], 'source_event_invalid')
    repository = os.path.abspath(repository)
    archive.require(archive.git(repository, ['rev-parse', 'HEAD']).decode().strip() == candidate, 'source_checkout_mismatch')
    archive.require(not archive.git(repository, ['status', '--porcelain', '--untracked-files=all']), 'source_checkout_dirty')
    tree, files = catalog(repository, candidate)
    _, baseline = catalog(repository, base)
    if event == 'pull_request':
        archive.require(isinstance(head, str) and archive.HEX40.fullmatch(head), 'source_head_required')
        commit = archive.git(repository, ['cat-file', 'commit', candidate])
        parents = [line[7:].decode() for line in commit.split(b'\n\n', 1)[0].splitlines() if line.startswith(b'parent ')]
        archive.require(parents == [base, head], 'source_integration_unproven')
    migrations = {path: row for path, row in baseline.items() if path.startswith('migrations/') and path.endswith('.sql')}
    issues = []
    for path, row in migrations.items():
        current = files.get(path)
        if current is None or any(current[key] != row[key] for key in ['mode', 'git_blob', 'bytes']):
            issues.append({'code': 'published_migration_changed', 'path': path})
    paths = set(files)
    for path in files:
        paths.update(str(parent) for parent in PurePosixPath(path).parents)
    links = 0
    for path, row in files.items():
        if not path.endswith('.md'):
            continue
        data = archive.git(repository, ['cat-file', 'blob', row['git_blob']], archive.MAX_FILE)
        archive.require(archive.git_hash('blob', data) == row['git_blob'], 'source_blob_mismatch')
        for raw in LINK.findall(data.decode('utf-8', 'strict')):
            target = raw.split('#', 1)[0]
            if not target or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('/'):
                continue
            links += 1
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), unquote(target)))
            if resolved not in paths:
                issues.append({'code': 'relative_link_missing', 'path': path, 'target': raw})
    return {'format': 'freedom.source-boundaries/v1', 'status': 'failed' if issues else 'passed',
            'source': candidate, 'tree': tree, 'base': base, 'event': event,
            'immutable_migrations': len(migrations), 'local_links': links, 'issues': issues,
            'complete_byte_inventory': 'release_archive', 'external_links_and_anchors': 'not_checked'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--base', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--event', required=True)
    parser.add_argument('--head')
    args = parser.parse_args()
    try:
        result = verify(args.repository, args.base, args.candidate, args.event, args.head)
    except (archive.ArchiveError, UnicodeError, ValueError, OSError) as error:
        result = {'format': 'freedom.source-boundaries/v1', 'status': 'failed',
                  'reason': str(error) if isinstance(error, archive.ArchiveError) else 'source_verification_unavailable'}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
