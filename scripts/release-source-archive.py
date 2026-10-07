#!/usr/bin/env python3
"""Bounded exact-Git source archive. No checkout code or archive member is executed."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import sys
import tarfile
import time

FORMAT = "freedom.source-archive/v1"
MAX_FILES, MAX_FILE, MAX_TOTAL = 16384, 4 * 1024**2, 256 * 1024**2
MAX_MANIFEST, MAX_ARCHIVE = 8 * 1024**2, MAX_TOTAL + MAX_FILES * 1024 + 10240
HEX40, HEX64 = re.compile(r"[0-9a-f]{40}\Z"), re.compile(r"[0-9a-f]{64}\Z")
GIT_ENV = {"PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_NO_REPLACE_OBJECTS": "1", "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"}


class ArchiveError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ArchiveError(code)


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git_hash(kind, data):
    return hashlib.sha1(kind.encode() + b" " + str(len(data)).encode() + b"\0" + data).hexdigest()


def safe_path(path):
    require(isinstance(path, str) and 0 < len(path.encode("utf-8")) <= 240, "archive_path_invalid")
    parts = path.split("/")
    require(all(part and part not in (".", "..", ".git") and not part.endswith((" ", ".")) for part in parts)
            and not any(ord(c) < 32 or ord(c) == 127 or c in "\\:" for c in path), "archive_path_invalid")
    require(all(not (part == ".env" or part.startswith(".env.")) or part == ".env.example" for part in parts), "archive_secret_path")
    return parts


def tree_hash(files):
    root, seen = {}, set()
    for entry in files:
        parts = safe_path(entry["path"])
        require(entry["path"].casefold() not in seen, "archive_duplicate_path")
        seen.add(entry["path"].casefold())
        node = root
        for part in parts[:-1]:
            require(not isinstance(node.get(part), tuple), "archive_path_collision")
            node = node.setdefault(part, {})
        require(parts[-1] not in node, "archive_path_collision")
        node[parts[-1]] = (entry["mode"], entry["git_blob"])
    def visit(node):
        rows = []
        for name, item in node.items():
            directory = isinstance(item, dict)
            mode, oid = ("40000", visit(item)) if directory else item
            encoded = name.encode("utf-8")
            rows.append((encoded + (b"/" if directory else b""), mode.encode() + b" " + encoded + b"\0" + bytes.fromhex(oid)))
        return git_hash("tree", b"".join(row for _, row in sorted(rows)))
    return visit(root)


def header(entry):
    info = tarfile.TarInfo(entry["path"])
    info.mode = int(entry["mode"][-3:], 8)
    info.size = entry["bytes"]
    # The remaining fields keep TarInfo's fixed zero/empty defaults. No PAX,
    # GNU long names, directory entries, links, devices or sparse extensions.
    return info.tobuf(format=tarfile.USTAR_FORMAT, encoding="utf-8", errors="strict")


def git(repository, args, limit=MAX_MANIFEST):
    command = ["/usr/bin/git", "--no-optional-locks", "-c", "core.hooksPath=/dev/null",
               "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", *args]
    with subprocess.Popen(command, cwd=repository, env=GIT_ENV, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0) as process:
        chunks, length, deadline = [], 0, time.monotonic() + 20
        try:
            with selectors.DefaultSelector() as poll:
                poll.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    require(remaining > 0 and poll.select(remaining), "archive_git_timeout")
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    length += len(chunk)
                    require(length <= limit, "archive_git_output_limit")
                    chunks.append(chunk)
            require(process.wait(timeout=max(0.001, deadline - time.monotonic())) == 0, "archive_git_unavailable")
            return b"".join(chunks)
        except BaseException:
            process.kill()
            process.wait(timeout=5)
            raise



def source_catalog(repository, source, expected_tree):
    require(HEX40.fullmatch(source) and HEX40.fullmatch(expected_tree), "archive_source_pin_required")
    require(os.path.isabs(repository) and os.path.realpath(repository) == repository, "archive_repository_invalid")
    require(git(repository, ["rev-parse", "--show-object-format"]).strip() == b"sha1", "archive_object_format_unsupported")
    for name in ("objects/info/alternates", "objects/info/http-alternates", "info/grafts"):
        metadata = git(repository, ["rev-parse", "--git-path", name]).decode().strip()
        require(not os.path.lexists(os.path.join(repository, metadata)), "archive_git_indirection")
    require(not git(repository, ["for-each-ref", "--format=%(refname)", "refs/replace/"]), "archive_git_indirection")
    commit = git(repository, ["cat-file", "commit", source], MAX_FILE)
    require(git_hash("commit", commit) == source and commit.split(b"\n", 1)[0] == b"tree " + expected_tree.encode(), "archive_source_mismatch")
    rows = git(repository, ["ls-tree", "-rlz", source]).split(b"\0")
    require(rows[-1] == b"" and 1 <= len(rows) - 1 <= MAX_FILES, "archive_file_limit")
    entries, total = [], 0
    for row in rows[:-1]:
        fields, path = row.split(b"\t", 1)
        mode, kind, oid, size = fields.split()
        require(mode in (b"100644", b"100755") and kind == b"blob", "archive_source_not_regular")
        entry = {"path": path.decode("utf-8", "strict"), "mode": mode.decode(), "git_blob": oid.decode(), "bytes": int(size)}
        safe_path(entry["path"])
        require(HEX40.fullmatch(entry["git_blob"]) and 0 <= entry["bytes"] <= MAX_FILE, "archive_file_limit")
        total += entry["bytes"]
        require(total <= MAX_TOTAL, "archive_total_limit")
        header(entry)  # Fail before creating output if USTAR cannot represent a path.
        entries.append(entry)
    entries.sort(key=lambda row: row["path"].encode())
    require(tree_hash(entries) == expected_tree, "archive_source_tree_mismatch")
    return entries


def directory_fd(path):
    require(os.path.isabs(path) and os.path.normpath(path) == path and os.path.realpath(path) == path, "archive_directory_invalid")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    value = os.fstat(fd)
    if value.st_uid != os.getuid() or value.st_mode & 0o022:
        os.close(fd)
        raise ArchiveError("archive_directory_invalid")
    return fd


@contextmanager
def new_directory(path):
    require(os.path.isabs(path) and os.path.normpath(path) == path, "archive_directory_invalid")
    parent, name = os.path.split(path)
    require(name not in ("", ".", ".."), "archive_directory_invalid")
    pfd, fd, made = directory_fd(parent), None, False
    try:
        os.mkdir(name, 0o700, dir_fd=pfd)  # Exclusive; never replace any existing output.
        made = True
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pfd)
        yield fd
        os.fsync(fd)
    except BaseException:
        if made:
            # All writes use the held directory fd. Never follow a replacement
            # symlink during failure cleanup or remove a foreign directory.
            current = os.stat(name, dir_fd=pfd, follow_symlinks=False)
            original = os.fstat(fd) if fd is not None else None
            if original and (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino):
                shutil.rmtree(name, dir_fd=pfd)
        raise
    finally:
        if fd is not None:
            os.close(fd)
        os.close(pfd)


def create_file(fd, path, mode=0o600):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd), "wb")


def write_file(fd, path, data, mode=0o400):
    with create_file(fd, path, mode) as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())


def build(repository, source, expected_tree, output):
    entries = source_catalog(repository, source, expected_tree)
    require(os.path.commonpath([repository, output]) != repository, "archive_output_inside_source")
    archive_hash = hashlib.sha256()
    with new_directory(output) as fd:
        with create_file(fd, "source.tar", 0o400) as out:
            size = 0
            def write(data):
                nonlocal size
                size += len(data)
                require(size <= MAX_ARCHIVE, "archive_total_limit")
                archive_hash.update(data)
                out.write(data)
            for entry in entries:
                data = git(repository, ["cat-file", "blob", entry["git_blob"]], MAX_FILE)
                require(len(data) == entry["bytes"] and git_hash("blob", data) == entry["git_blob"], "archive_source_blob_mismatch")
                entry["sha256"] = digest(data)
                write(header(entry)); write(data); write(b"\0" * (-len(data) % 512))
            write(b"\0" * 1024)
            write(b"\0" * (-size % 10240))
            out.flush(); os.fsync(out.fileno())
        manifest = {"format": FORMAT, "source_commit": source, "source_tree": expected_tree,
                    "tool_sha256": digest(Path(__file__).read_bytes()), "files": entries}
        raw = canonical(manifest)
        require(len(raw) <= MAX_MANIFEST, "archive_manifest_limit")
        write_file(fd, "inventory.json", raw)
        receipt = {"format": "freedom.source-archive-receipt/v1", "source_commit": source, "source_tree": expected_tree,
                   "inventory_sha256": digest(raw), "archive_sha256": archive_hash.hexdigest(), "files": len(entries),
                   "source_bytes": sum(e["bytes"] for e in entries), "archive_bytes": size, "tool_sha256": manifest["tool_sha256"],
                   "assurance": "local-source-archive", "deployment_authorized": False}
        # Completion marker is last. A killed build has no complete receipt.
        write_file(fd, "complete.json", canonical(receipt))
    return receipt


@contextmanager
def bounded_file(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit, "archive_file_invalid")
        with os.fdopen(fd, "rb", closefd=False) as source:
            yield source
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink), "archive_file_changed")
    finally:
        os.close(fd)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "archive_manifest_duplicate_key")
        result[key] = value
    return result


def inventory(path, source, tree, expected_digest):
    require(HEX40.fullmatch(source) and HEX40.fullmatch(tree) and HEX64.fullmatch(expected_digest), "archive_source_pin_required")
    with bounded_file(path, MAX_MANIFEST) as file:
        raw = file.read(MAX_MANIFEST + 1)
    require(digest(raw) == expected_digest, "archive_inventory_pin_mismatch")
    value = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=unique_object)
    require(type(value) is dict and set(value) == {"format", "source_commit", "source_tree", "tool_sha256", "files"}, "archive_manifest_invalid")
    require(value["format"] == FORMAT and value["source_commit"] == source and value["source_tree"] == tree,
            "archive_source_mismatch")
    require(isinstance(value["tool_sha256"], str) and HEX64.fullmatch(value["tool_sha256"]), "archive_manifest_invalid")
    files = value["files"]
    require(type(files) is list and 1 <= len(files) <= MAX_FILES, "archive_file_limit")
    total = 0
    for entry in files:
        require(type(entry) is dict and set(entry) == {"path", "mode", "git_blob", "bytes", "sha256"}, "archive_manifest_invalid")
        safe_path(entry["path"])
        require(entry["mode"] in ("100644", "100755") and type(entry["bytes"]) is int and 0 <= entry["bytes"] <= MAX_FILE
                and isinstance(entry["sha256"], str) and HEX64.fullmatch(entry["sha256"])
                and isinstance(entry["git_blob"], str) and HEX40.fullmatch(entry["git_blob"]), "archive_manifest_invalid")
        total += entry["bytes"]
        require(total <= MAX_TOTAL, "archive_total_limit")
        header(entry)
    require(files == sorted(files, key=lambda entry: entry["path"].encode()) and raw == canonical(value), "archive_manifest_noncanonical")
    require(tree_hash(files) == tree, "archive_source_tree_mismatch")
    return value


def checked_data(file, entry):
    data = file.read(entry["bytes"])
    require(len(data) == entry["bytes"] and digest(data) == entry["sha256"] and git_hash("blob", data) == entry["git_blob"], "archive_content_mismatch")
    return data


def verify_stream(file, files):
    offsets, archive_hash = [], hashlib.sha256()
    for entry in files:
        raw = file.read(512)
        # Exact canonical stdlib USTAR header comparison validates name, size,
        # mode, checksum and all metadata before any restore directory exists.
        require(raw == header(entry), "archive_header_mismatch")
        offsets.append(file.tell())
        data = checked_data(file, entry)
        pad = file.read(-entry["bytes"] % 512)
        require(pad == b"\0" * len(pad) and len(pad) == -entry["bytes"] % 512, "archive_padding_invalid")
        archive_hash.update(raw); archive_hash.update(data); archive_hash.update(pad)
    # build() always writes two zero blocks, then zero-fills to a 10240-byte
    # record, so the exact trailer length follows from the content offset.
    expected = 1024 + (-(file.tell() + 1024) % 10240)
    trailer = file.read(expected)
    require(len(trailer) == expected and not trailer.strip(b"\0") and file.tell() % 10240 == 0 and not file.read(1), "archive_trailer_invalid")
    archive_hash.update(trailer)
    return offsets, archive_hash.hexdigest()


def parent_fd(root, parts):
    fd = os.dup(root)
    try:
        for part in parts:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def restored_files(root, allowed_directories, prefix=""):
    result = []
    for name in sorted(os.listdir(root)):
        info = os.stat(name, dir_fd=root, follow_symlinks=False)
        path = prefix + name
        if stat.S_ISDIR(info.st_mode):
            require(path in allowed_directories, "archive_restore_extra_directory")
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            try:
                result.extend(restored_files(fd, allowed_directories, path + "/"))
            finally:
                os.close(fd)
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= MAX_FILE, "archive_restore_invalid")
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
            with os.fdopen(fd, "rb") as file:
                data = file.read(MAX_FILE + 1)
                observed = os.fstat(file.fileno())
            require(len(data) == info.st_size and (observed.st_dev, observed.st_ino, observed.st_mode) == (info.st_dev, info.st_ino, info.st_mode), "archive_restore_changed")
            require(stat.S_IMODE(observed.st_mode) in (0o644, 0o755), "archive_restore_invalid")
            result.append({"path": path, "mode": "100755" if observed.st_mode & 0o111 else "100644", "bytes": len(data), "sha256": digest(data), "git_blob": git_hash("blob", data)})
    return result


def verify_restore(archive, manifest, source, tree, expected_digest, output=None):
    value = inventory(manifest, source, tree, expected_digest)
    files = value["files"]
    with bounded_file(archive, MAX_ARCHIVE) as file:
        initial = os.fstat(file.fileno())
        offsets, archive_digest = verify_stream(file, files)
        if output is not None:
            with new_directory(output) as root:
                for entry, offset in zip(files, offsets):
                    file.seek(offset)
                    data = checked_data(file, entry)  # Recheck on the second read.
                    parts = safe_path(entry["path"])
                    fd = parent_fd(root, parts[:-1])
                    try:
                        with create_file(fd, parts[-1], int(entry["mode"][-3:], 8)) as target:
                            target.write(data); target.flush(); os.fchmod(target.fileno(), int(entry["mode"][-3:], 8)); os.fsync(target.fileno())
                    finally:
                        os.close(fd)
                directories = {"/".join(parts[:i]) for entry in files for parts in [entry["path"].split("/")] for i in range(1, len(parts))}
                observed = sorted(restored_files(root, directories), key=lambda entry: entry["path"].encode())
                require(observed == files and tree_hash(observed) == tree, "archive_restore_mismatch")
                final = os.fstat(file.fileno())
                require((initial.st_size, initial.st_mtime_ns, initial.st_ctime_ns) == (final.st_size, final.st_mtime_ns, final.st_ctime_ns), "archive_file_changed")
    return {"format": "freedom.source-archive-verification/v1", "source_commit": source, "source_tree": tree,
            "inventory_sha256": expected_digest, "archive_sha256": archive_digest, "files": len(files),
            "source_bytes": sum(entry["bytes"] for entry in files), "restored": output is not None,
            "assurance": "local-source-archive", "deployment_authorized": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_args = commands.add_parser("build")
    build_args.add_argument("--repository", required=True)
    build_args.add_argument("--output", required=True)
    check_args = commands.add_parser("verify")
    check_args.add_argument("--archive", required=True)
    check_args.add_argument("--inventory", required=True)
    check_args.add_argument("--expected-inventory", required=True)
    check_args.add_argument("--restore-to")
    for sub in (build_args, check_args):
        sub.add_argument("--source", required=True)
        sub.add_argument("--expected-tree", required=True)
    args = parser.parse_args()
    try:
        if args.command == "build":
            result = build(args.repository, args.source, args.expected_tree, args.output)
        else:
            result = verify_restore(args.archive, args.inventory, args.source, args.expected_tree, args.expected_inventory, args.restore_to)
        print(canonical(result).decode(), end="")
    except (ArchiveError, OSError, ValueError, UnicodeError, tarfile.TarError, subprocess.SubprocessError, RecursionError) as error:
        print(json.dumps({"ok": False, "code": str(error) if isinstance(error, ArchiveError) else "archive_io_or_format_error"}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
