"""Local exact-Git archive/restore cases; no provider or repository hooks run."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "release-source-archive.py"
spec = importlib.util.spec_from_file_location("source_archive", SCRIPT)
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class SourceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fp-source-archive-"))
        self.addCleanup(shutil.rmtree, self.root)
        self.repository = self.root / "repository"
        self.repository.mkdir(mode=0o700)
        self.env = {**archive.GIT_ENV, "GIT_AUTHOR_NAME": "Archive Fixture", "GIT_AUTHOR_EMAIL": "archive@example.invalid",
                    "GIT_COMMITTER_NAME": "Archive Fixture", "GIT_COMMITTER_EMAIL": "archive@example.invalid"}
        self.git("init", "-q", "-b", "main")
        sources = {"README.md": b"# Synthetic source\n", "migrations/001_base.sql": b"CREATE TABLE example(id integer);\n",
                   "contracts/common/v1/wire.json": b'{"version":1}\n', "assets/public.bin": bytes(range(256)),
                   "scripts/executable.sh": b"#!/bin/sh\nexit 99\n", "docs/中文.md": "精確 UTF-8\n".encode(),
                   ".gitattributes": b"assets/public.bin export-ignore\n"}
        for path, data in sources.items():
            target = self.repository / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        (self.repository / "scripts/executable.sh").chmod(0o755)
        self.commit()
        self.output = self.root / "release"
        self.restored = self.root / "restored"

    def git(self, *args):
        return subprocess.check_output(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", *args], cwd=self.repository,
                                       env=self.env, stderr=subprocess.DEVNULL).decode().strip()

    def commit(self):
        self.git("add", ".")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic immutable source")
        self.source = self.git("rev-parse", "HEAD")
        self.tree = self.git("rev-parse", "HEAD^{tree}")

    def build(self):
        result = archive.build(str(self.repository), self.source, self.tree, str(self.output))
        self.pin = result["inventory_sha256"]
        return result

    def verify(self, restore=True):
        return archive.verify_restore(str(self.output / "source.tar"), str(self.output / "inventory.json"),
                                      self.source, self.tree, self.pin, str(self.restored) if restore else None)

    def rejected(self, code=None):
        with self.assertRaises(archive.ArchiveError) as error:
            self.verify()
        if code:
            self.assertEqual(str(error.exception), code)
        self.assertFalse(self.restored.exists())

    def rewrite_tar(self, data):
        path = self.output / "source.tar"
        path.chmod(0o600)
        path.write_bytes(data)

    def rewrite_inventory(self, value):
        path = self.output / "inventory.json"
        path.chmod(0o600)
        data = archive.canonical(value)
        path.write_bytes(data)
        self.pin = archive.digest(data)  # Even a caller-pinned forged manifest must match the independent Git tree.

    def test_real_git_full_archive_restores_bytes_modes_and_ignores_worktree_state(self):
        (self.repository / "README.md").write_text("uncommitted candidate text")
        (self.repository / ".env").write_text("SYNTHETIC_PRIVATE_NOT_ARCHIVED=yes")
        receipt = self.build()
        result = self.verify()
        self.assertEqual(result["archive_sha256"], receipt["archive_sha256"])
        self.assertEqual(result["files"], 7)
        self.assertTrue(result["restored"])
        self.assertFalse(result["deployment_authorized"])
        self.assertEqual((self.restored / "README.md").read_bytes(), b"# Synthetic source\n")
        self.assertEqual((self.restored / "assets/public.bin").read_bytes(), bytes(range(256)))
        self.assertEqual((self.restored / "scripts/executable.sh").stat().st_mode & 0o777, 0o755)
        self.assertFalse((self.restored / ".env").exists())
        self.assertEqual(json.loads((self.output / "complete.json").read_text()), receipt)
        # External Git independently recomputes the restored complete tree.
        subprocess.check_call(["/usr/bin/git", "init", "-q"], cwd=self.restored, env=self.env)
        subprocess.check_call(["/usr/bin/git", "add", "."], cwd=self.restored, env=self.env)
        observed = subprocess.check_output(["/usr/bin/git", "write-tree"], cwd=self.restored, env=self.env).decode().strip()
        self.assertEqual(observed, self.tree)

    def test_cli_requires_external_pins_and_performs_actual_build_verify_restore(self):
        command = ["/usr/bin/python3", str(SCRIPT)]
        result = subprocess.run(command + ["build", "--repository", str(self.repository), "--source", self.source,
                                  "--expected-tree", self.tree, "--output", str(self.output)], capture_output=True, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        args = ["verify", "--archive", str(self.output / "source.tar"), "--inventory", str(self.output / "inventory.json"),
                "--source", self.source, "--expected-tree", self.tree, "--expected-inventory", receipt["inventory_sha256"], "--restore-to", str(self.restored)]
        result = subprocess.run(command + args, capture_output=True, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["files"], 7)
        bad = subprocess.run(command + args[:-4] + ["--expected-inventory", "f" * 64], capture_output=True, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(bad.returncode, 1)
        self.assertEqual(json.loads(bad.stderr)["code"], "archive_inventory_pin_mismatch")

    def test_every_record_alignment_builds_verifies_and_restores_exactly(self):
        # One file of k*512 bytes puts the members at (k+1)*512 bytes, which
        # covers all 20 offsets modulo the 10240-byte record, including 9728
        # where the trailer is 1024+9728 bytes.
        alignments = set()
        for blocks in range(20):
            with self.subTest(blocks=blocks):
                self.repository = self.root / f"aligned-{blocks}"
                self.repository.mkdir(mode=0o700)
                self.git("init", "-q", "-b", "main")
                (self.repository / "data.bin").write_bytes(bytes([blocks + 1]) * (blocks * 512))
                self.commit()
                self.output, self.restored = self.root / f"release-{blocks}", self.root / f"restored-{blocks}"
                receipt = self.build()
                content = (blocks + 1) * 512
                alignments.add(content % 10240)
                self.assertEqual(receipt["archive_bytes"], content + 1024 + (-(content + 1024) % 10240))
                self.assertEqual(receipt["archive_bytes"] % 10240, 0)
                with tarfile.open(self.output / "source.tar") as stdlib:  # Independent reader.
                    self.assertEqual([(m.name, m.size) for m in stdlib.getmembers()], [("data.bin", blocks * 512)])
                self.assertEqual(self.verify()["archive_sha256"], receipt["archive_sha256"])
                self.assertEqual((self.restored / "data.bin").read_bytes(), bytes([blocks + 1]) * (blocks * 512))
                original = (self.output / "source.tar").read_bytes()
                shutil.rmtree(self.restored)
                for data in [original + b"\0" * 10240, original[:-512], original[:-10240]]:
                    self.rewrite_tar(data)
                    self.rejected()
        self.assertEqual(alignments, set(range(0, 10240, 512)))

    def test_source_and_inventory_pins_cannot_be_replaced_by_embedded_claims(self):
        self.build()
        self.pin = "f" * 64
        self.rejected("archive_inventory_pin_mismatch")
        self.pin = archive.digest((self.output / "inventory.json").read_bytes())
        self.source = "f" * 40
        self.rejected("archive_source_mismatch")

    def test_modified_sql_or_contract_bytes_of_same_length_fail_before_restore(self):
        self.build()
        value = json.loads((self.output / "inventory.json").read_text())
        original = (self.output / "source.tar").read_bytes()
        with (self.output / "source.tar").open("rb") as file:
            offsets, _ = archive.verify_stream(file, value["files"])
        for path in ["migrations/001_base.sql", "contracts/common/v1/wire.json"]:
            with self.subTest(path=path):
                index = next(i for i, entry in enumerate(value["files"]) if entry["path"] == path)
                data = bytearray(original); data[offsets[index]] ^= 1
                self.rewrite_tar(data)
                self.rejected("archive_content_mismatch")

    def test_missing_extra_reordered_duplicate_and_truncated_members_fail(self):
        self.build()
        original = (self.output / "source.tar").read_bytes()
        for data in [original[1024:], original[:1024] + original, original[:512] + original[1024:],
                     original[:-1], original + b"not-another-archive", original[:512] + b"x" + original[513:]]:
            with self.subTest(size=len(data)):
                self.rewrite_tar(data); self.rejected()
        value = json.loads((self.output / "inventory.json").read_text())
        value["files"].pop(); self.rewrite_inventory(value)
        self.rejected("archive_source_tree_mismatch")

    def test_noncanonical_headers_links_metadata_traversal_and_modes_fail(self):
        self.build()
        original = (self.output / "source.tar").read_bytes()
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE, tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME]:
            info = tarfile.TarInfo("../../outside"); info.type = kind; info.linkname = "../../outside"
            self.rewrite_tar(info.tobuf(format=tarfile.USTAR_FORMAT) + original[512:]); self.rejected("archive_header_mismatch")
        info = tarfile.TarInfo(".gitattributes"); info.mode = 0o777; info.size = 38
        self.rewrite_tar(info.tobuf(format=tarfile.USTAR_FORMAT) + original[512:]); self.rejected("archive_header_mismatch")
        for path in ["../outside", "/absolute", "a/../outside", "a\\outside", ".git/config", ".env"]:
            value = json.loads((self.output / "inventory.json").read_text()); value["files"][0]["path"] = path
            self.rewrite_inventory(value); self.rejected()

    def test_alternates_grafts_and_replace_refs_are_refused_without_network(self):
        for name in ["objects/info/alternates", "objects/info/http-alternates", "info/grafts"]:
            path = self.repository / self.git("rev-parse", "--git-path", name)
            path.write_text("")
            with self.assertRaisesRegex(archive.ArchiveError, "archive_git_indirection"):
                self.build()
            path.unlink()
        self.git("update-ref", "refs/replace/" + self.source, self.source)
        with self.assertRaisesRegex(archive.ArchiveError, "archive_git_indirection"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_special_git_members_and_committed_secret_paths_are_rejected(self):
        (self.repository / "link").symlink_to("README.md"); self.commit()
        with self.assertRaisesRegex(archive.ArchiveError, "archive_source_not_regular"):
            self.build()
        (self.repository / "link").unlink(); (self.repository / ".env").write_text("SYNTHETIC_ONLY=yes"); self.commit()
        with self.assertRaisesRegex(archive.ArchiveError, "archive_secret_path"):
            self.build()

    def test_caps_are_fail_closed_without_selecting_a_smaller_archive(self):
        for name, value in [("MAX_FILES", 2), ("MAX_FILE", 1), ("MAX_TOTAL", 1)]:
            with self.subTest(limit=name), patch.object(archive, name, value), self.assertRaises(archive.ArchiveError):
                self.build()
            self.assertFalse(self.output.exists())
        self.build()
        with patch.object(archive, "MAX_MANIFEST", 20), self.assertRaisesRegex(archive.ArchiveError, "archive_file_invalid"):
            self.verify()

    def test_existing_output_and_symlink_inputs_are_never_replaced_or_followed(self):
        self.output.mkdir(); sentinel = self.output / "keep"; sentinel.write_text("unchanged")
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(sentinel.read_text(), "unchanged")
        shutil.rmtree(self.output); self.build()
        self.restored.symlink_to(self.root / "foreign")
        with self.assertRaises(FileExistsError):
            self.verify()
        self.assertTrue(self.restored.is_symlink()); self.restored.unlink()
        link = self.root / "linked-parent"; link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(archive.ArchiveError, "archive_directory_invalid"):
            archive.verify_restore(str(self.output / "source.tar"), str(self.output / "inventory.json"), self.source, self.tree, self.pin, str(link / "new"))
        original = self.output / "source.tar"; original.rename(self.root / "original.tar"); original.symlink_to(self.root / "original.tar")
        with self.assertRaises(OSError):
            self.verify()

    def test_partial_build_failure_has_no_complete_artifact(self):
        actual_git, calls = archive.git, 0
        def failing_git(root, args, *rest):
            nonlocal calls
            if args[:2] == ["cat-file", "blob"]:
                calls += 1
                if calls == 2:
                    raise archive.ArchiveError("synthetic_interrupted_read")
            return actual_git(root, args, *rest)
        with patch.object(archive, "git", failing_git), self.assertRaisesRegex(archive.ArchiveError, "synthetic_interrupted_read"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_restore_rechecks_bytes_after_validation_and_removes_partial_destination(self):
        self.build()
        total = json.loads((self.output / "inventory.json").read_text())["files"]
        actual_read, count = archive.checked_data, 0
        def mutate_after_validation(file, entry):
            nonlocal count
            count += 1
            if count == len(total) + 1:
                data = bytearray((self.output / "source.tar").read_bytes()); data[file.tell()] ^= 1
                self.rewrite_tar(data)
            return actual_read(file, entry)
        with patch.object(archive, "checked_data", mutate_after_validation), self.assertRaisesRegex(archive.ArchiveError, "archive_content_mismatch|archive_file_changed"):
            self.verify()
        self.assertFalse(self.restored.exists())

    def test_restore_directory_symlink_race_does_not_write_foreign_path(self):
        self.build()
        foreign = self.root / "foreign"; foreign.mkdir(); (foreign / "keep").write_text("unchanged")
        actual_mkdir = os.mkdir
        def racing_mkdir(path, *args, **kwargs):
            result = actual_mkdir(path, *args, **kwargs)
            if path == "docs" and kwargs.get("dir_fd") is not None:
                os.rmdir("docs", dir_fd=kwargs["dir_fd"])
                os.symlink(str(foreign), "docs", dir_fd=kwargs["dir_fd"])
            return result
        with patch.object(os, "mkdir", racing_mkdir), self.assertRaises(OSError):
            self.verify()
        self.assertFalse(self.restored.exists())
        self.assertEqual(list(foreign.iterdir()), [foreign / "keep"])
        self.assertEqual((foreign / "keep").read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main(verbosity=2)
