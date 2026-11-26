"""Pins check_deleted_tests.py: a test the branch deletes needs a trailer that names its survivor at the tip, or
a mark of CODING_STANDARDS.md § Tests."""
import contextlib
import io
import pathlib
import subprocess
import tempfile
import unittest

import check_deleted_tests as cdt

STANDARDS = ('## Comments\n- A comment restates an ADR. → Cite it.\n'
             '## Tests\n- A test proves an absence: a removed method. → Delete it.\n## Naming\n')
CS = '''public class Tests
{
    [Fact]
    public void Kept() { }

    [Theory]
    [InlineData(1)]
    public async Task Removed_theory<T>(int value) { }

    [InstalledGameTheory(Skip = "x")]
    public void Removed_custom() { }

    [Fact]
    public void Removed_fact() => Assert.True(Helper(1));
}
'''
TS = '''describe('box', () => {
  it('kept', () => {});
  it('says the editor\\'s name', () => {});
  it.each([['a', f([1])(2)], ['b']])('rows %s', (name) => {});
  it.skip("skipped", () => {});
  test(`templated`, () => {});
});
'''
PY = '''class Case(unittest.TestCase):
    def test_kept(self) -> None: ...
    def test_removed(self) -> None: ...
    def helper(self) -> None: ...
'''


class Repo(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = pathlib.Path(tmp.name)
        self.git('init', '-q', '-b', 'main')
        self.write('CODING_STANDARDS.md', STANDARDS)
        self.write('Box.Tests/Tests.cs', CS)
        self.write('modbench/src/box/test/box.test.ts', TS)
        self.write('scripts/tests/test_box.py', PY)
        self.commit('base')
        self.git('checkout', '-q', '-b', 'branch')

    def git(self, *args: str) -> None:
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=t', '-c', 'user.email=t@t', *args],
                       check=True, capture_output=True)

    def write(self, path: str, text: str) -> None:
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def commit(self, message: str) -> None:
        self.git('add', '-A')
        self.git('commit', '-q', '--allow-empty', '-m', message)

    def keep_only_the_kept_tests(self) -> None:
        self.write('Box.Tests/Tests.cs', '[Fact]\npublic void Kept() { }\n')
        self.write('modbench/src/box/test/box.test.ts', "it('kept', () => {});\n")
        self.write('scripts/tests/test_box.py', '    def test_kept(self) -> None: ...\n')

    def main(self) -> tuple[int, str]:
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            status = cdt.main([str(self.root), 'main'])
        return status, printed.getvalue()


class Deleted(Repo):
    def test_each_test_the_branch_deletes_that_no_trailer_names_is_named(self) -> None:
        self.keep_only_the_kept_tests()
        self.commit('delete')
        self.assertEqual(cdt.problems(self.root, 'main'), [
            f"{name}: deleted, and no trailer names its survivor: {cdt.FORM}"
            for name in ('Removed_custom', 'Removed_fact', 'Removed_theory', 'rows %s', "says the editor's name", 'skipped',
                         'templated', 'test_removed')])

    def test_a_test_moved_to_another_file_or_added_and_deleted_on_the_branch_is_not_deleted(self) -> None:
        self.write('Other.Tests/Tests.cs', '[Fact]\npublic void Added() { }\n')
        self.commit('add')
        self.write('Other.Tests/Tests.cs', '[Fact]\npublic void Removed_fact() { }\n')
        self.write('Box.Tests/Tests.cs', CS.replace('Removed_fact', 'Kept_too'))
        self.commit('move')
        self.assertEqual(cdt.problems(self.root, 'main'), [])

    def test_a_test_main_adds_after_the_branch_left_it_is_not_deleted_by_the_branch(self) -> None:
        self.git('checkout', '-q', 'main')
        self.write('scripts/tests/test_box.py', PY + '    def test_added_on_main(self) -> None: ...\n')
        self.commit('add on main')
        self.git('checkout', '-q', 'branch')
        self.assertEqual(cdt.problems(self.root, 'main'), [])


class Trailer(Repo):
    def test_each_deletion_is_accounted_for_by_a_survivor_at_the_tip_or_a_mark_of_tests_and_each_other_trailer_is_named(self) -> None:
        self.keep_only_the_kept_tests()
        self.commit('delete\n\nDeleted-test: test_removed => Kept\nDeleted-test: Removed_fact => test_gone\n'
                    'Deleted-test: Removed_theory => mark: A test proves an absence\n'
                    'Deleted-test: Removed_custom => mark: A comment restates an ADR\nDeleted-test: rows %s => mark: A test\n'
                    'Deleted-test: skipped')
        self.commit("name the rest from a later commit\n\nDeleted-test: templated => kept\n"
                    "Deleted-test: says the editor's name => test_kept\nCo-Authored-By: t <t@t>")
        self.assertEqual(cdt.problems(self.root, 'main'), [
            f"Deleted-test: skipped: reads {cdt.FORM}",
            'Removed_fact => test_gone: no test at the tip and no mark of CODING_STANDARDS.md § Tests reads so',
            'Removed_custom => mark: A comment restates an ADR: no test at the tip and no mark of CODING_STANDARDS.md § Tests reads so',
            'rows %s => mark: A test: no test at the tip and no mark of CODING_STANDARDS.md § Tests reads so',
            f'skipped: deleted, and no trailer names its survivor: {cdt.FORM}',
        ])

    def test_a_survivor_deleted_later_on_the_branch_is_named_until_a_later_trailer_names_one_that_stands(self) -> None:
        self.write('scripts/tests/test_box.py', '    def test_kept(self) -> None: ...\n')
        self.commit('delete\n\nDeleted-test: test_removed => Kept')
        self.write('Box.Tests/Tests.cs', CS.replace('Kept', 'Renamed'))
        self.commit('rename\n\nDeleted-test: Kept => Renamed')
        named = cdt.problems(self.root, 'main')
        self.commit('repair\n\nDeleted-test: test_removed => Renamed')
        self.assertEqual((named, cdt.problems(self.root, 'main')), (
            ['test_removed => Kept: no test at the tip and no mark of CODING_STANDARDS.md § Tests reads so'], []))


class Main(Repo):
    def test_it_ends_with_the_count_of_findings_and_fails_the_run_on_any(self) -> None:
        self.keep_only_the_kept_tests()
        self.commit('delete')
        status, printed = self.main()
        self.assertEqual((status, printed.splitlines()[-1]), (1, '--- 8 FINDINGS ON DELETED TESTS ---'))

    def test_it_passes_a_branch_that_deletes_nothing(self) -> None:
        self.assertEqual(self.main(), (0, '--- 0 FINDINGS ON DELETED TESTS ---\n'))


if __name__ == '__main__':
    unittest.main()
