"""Real Git adversarial cases for the daily boundary, on disposable disk paths."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('source_boundaries', Path(__file__).with_name('verify-source-boundaries.py'))
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)


class SourceBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='fp-source-boundary-')).resolve()
        self.addCleanup(shutil.rmtree, self.root)
        self.env = {**boundary.archive.GIT_ENV, 'GIT_AUTHOR_NAME': 'Synthetic Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                    'GIT_COMMITTER_NAME': 'Synthetic Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
        self.git('init', '-q', '-b', 'main')
        self.write('README.md', '[migration](migrations/001_base.sql)\n')
        self.write('migrations/001_base.sql', 'CREATE TABLE synthetic(id integer);\n')
        self.write('contracts/example/v1/wire.json', '{"version":1}\n')
        self.write('docs/legacy-inventory.json', '{"historical":"unchanged"}\n')
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', *args], cwd=self.root, env=self.env, stderr=subprocess.DEVNULL).decode().strip()

    def write(self, name, text):
        path = self.root/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'Synthetic change')
        return self.git('rev-parse', 'HEAD')

    def verify(self, **kwargs):
        return boundary.verify(str(self.root), self.base, self.git('rev-parse', 'HEAD'), kwargs.get('event', 'push'), kwargs.get('head'))

    def test_local_leaf_needs_no_inventory_edit_and_new_migration_is_allowed(self):
        before = (self.root/'docs/legacy-inventory.json').read_bytes()
        self.write('modules/guild/example.tsx', 'export const title="Synthetic";\n')
        self.write('migrations/002_add.sql', 'ALTER TABLE synthetic ADD COLUMN title text;\n')
        self.commit()
        result = self.verify()
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['immutable_migrations'], 1)
        self.assertEqual((self.root/'docs/legacy-inventory.json').read_bytes(), before)

    def test_migration_edit_delete_and_mode_change_are_rejected(self):
        for action in ['edit', 'delete', 'mode']:
            with self.subTest(action=action):
                self.git('reset', '--hard', self.base)
                path = self.root/'migrations/001_base.sql'
                if action == 'edit': path.write_text('DROP TABLE synthetic;\n')
                elif action == 'delete': path.unlink()
                else: path.chmod(0o755)
                self.commit()
                self.assertIn('published_migration_changed', [x['code'] for x in self.verify()['issues']])

    def test_missing_relative_link_fails_without_reading_outside_git_tree(self):
        self.write('README.md', '[missing](docs/missing.md) [outside](../outside.md) [web](https://example.invalid/)\n')
        self.commit()
        result = self.verify()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(len(result['issues']), 2)

    def test_dirty_and_untracked_checkout_cannot_claim_committed_evidence(self):
        self.write('untracked.txt', 'private scratch')
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_checkout_dirty'): self.verify()
        (self.root/'untracked.txt').unlink()
        self.write('README.md', 'uncommitted')
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_checkout_dirty'): self.verify()

    def test_index_flags_cannot_hide_changed_checkout_migrations(self):
        path = 'migrations/001_base.sql'
        for flag in ['--assume-unchanged', '--skip-worktree']:
            with self.subTest(flag=flag):
                self.git('update-index', flag, path)
                self.write(path, 'DROP TABLE synthetic;\n')
                self.assertEqual(self.git('status', '--porcelain', '--untracked-files=all'), '')
                with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_index_flags'):
                    self.verify()
                self.git('update-index', '--no-assume-unchanged', '--no-skip-worktree', path)
                self.git('reset', '--hard', self.base)

    def test_index_stat_cache_cannot_hide_same_size_changed_bytes(self):
        path = self.root/'migrations/001_base.sql'
        os.utime(path, (1700000000, 1700000000))
        self.git('update-index', '--refresh')
        before = path.stat()
        self.git('config', 'core.trustctime', 'false')
        self.git('config', 'core.checkStat', 'minimal')
        path.write_text('DROP TABLE synthetic;'.ljust(before.st_size-1)+'\n')
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        # A status refresh can cache the false stat match even before trusted checking.
        self.assertEqual(self.git('status', '--porcelain', '--untracked-files=all'), '')
        self.assertEqual(self.git('ls-files', '-v', 'migrations/001_base.sql')[0], 'H')
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_checkout_mismatch'):
            self.verify()

    def test_checkout_reader_rejects_missing_file_and_file_or_parent_symlink(self):
        _, files = boundary.catalog(str(self.root), self.base)
        path = self.root/'migrations/001_base.sql'
        original = path.read_bytes()
        path.unlink()
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_checkout_unreadable'):
            boundary.checked_checkout(str(self.root), files)
        outside = Path(tempfile.mkdtemp(prefix='fp-source-outside-'))
        self.addCleanup(shutil.rmtree, outside)
        (outside/'001_base.sql').write_bytes(original)
        path.symlink_to(outside/'001_base.sql')
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_checkout_unreadable'):
            boundary.checked_checkout(str(self.root), files)
        path.unlink()
        path.write_bytes(original)
        self.git('reset', '--hard', self.base)
        shutil.rmtree(self.root/'migrations')
        (self.root/'migrations').symlink_to(outside)
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_checkout_unreadable'):
            boundary.checked_checkout(str(self.root), files)

    def test_checkout_reader_rejects_mode_change_and_nonregular_file(self):
        _, files = boundary.catalog(str(self.root), self.base)
        path = self.root/'migrations/001_base.sql'
        path.chmod(0o755)
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_checkout_mismatch'):
            boundary.checked_checkout(str(self.root), files)
        path.unlink()
        os.mkfifo(path)
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_checkout_not_regular'):
            boundary.checked_checkout(str(self.root), files)

    def test_head_only_and_wrong_parent_are_not_a_pr_integration(self):
        self.git('switch', '-qc', 'candidate')
        self.write('leaf.tsx', 'export const label="example";\n')
        head = self.commit()
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_integration_unproven'):
            self.verify(event='pull_request', head=head)
        self.git('switch', 'main')
        self.git('merge', '--no-ff', '-qm', 'Synthetic merge', 'candidate')
        self.assertEqual(self.verify(event='pull_request', head=head)['status'], 'passed')
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'source_integration_unproven'):
            self.verify(event='pull_request', head=self.base)

    def test_committed_symlink_and_git_replacement_are_rejected(self):
        (self.root/'link').symlink_to('README.md')
        self.commit()
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'archive_source_not_regular'): self.verify()
        self.git('reset', '--hard', self.base)
        self.write('leaf.txt', 'changed')
        head = self.commit()
        self.git('replace', self.base, head)
        with self.assertRaisesRegex(boundary.archive.ArchiveError, 'archive_git_indirection'): self.verify()


if __name__ == '__main__':
    unittest.main()
