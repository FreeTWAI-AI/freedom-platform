"""Real Git adversarial cases for the daily boundary, on disposable disk paths."""
import importlib.util
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
