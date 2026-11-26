"""Pins check_deleted_tests.py: a test the branch deletes needs a trailer that names its survivor at the tip, or
a mark of CODING_STANDARDS.md."""
import contextlib
import io
import pathlib
import subprocess
import tempfile
import unittest

import check_deleted_tests as cdt

STANDARDS = '- A test proves an absence: a removed method. → Delete it.\n'
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
            "Removed_custom: deleted, and no 'Deleted-test:' trailer names it",
            "Removed_fact: deleted, and no 'Deleted-test:' trailer names it",
            "Removed_theory: deleted, and no 'Deleted-test:' trailer names it",
            "rows %s: deleted, and no 'Deleted-test:' trailer names it",
            "says the editor's name: deleted, and no 'Deleted-test:' trailer names it",
            "skipped: deleted, and no 'Deleted-test:' trailer names it",
            "templated: deleted, and no 'Deleted-test:' trailer names it",
            "test_removed: deleted, and no 'Deleted-test:' trailer names it",
        ])

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
    def delete_test_removed(self, *trailers: str) -> None:
        self.write('scripts/tests/test_box.py', '    def test_kept(self) -> None: ...\n')
        self.commit('delete\n\n' + '\n'.join(trailers))

    def test_a_survivor_that_stands_at_the_tip_clears_the_deletion_from_any_commit_on_the_branch(self) -> None:
        self.delete_test_removed()
        self.commit('name it\n\nDeleted-test: test_removed => test_kept\nCo-Authored-By: t <t@t>')
        self.assertEqual(cdt.problems(self.root, 'main'), [])

    def test_a_survivor_that_is_no_test_at_the_tip_is_named(self) -> None:
        self.delete_test_removed('Deleted-test: test_removed => test_gone')
        self.assertEqual(cdt.problems(self.root, 'main'),
                         ['test_removed => test_gone: the survivor is no test at the tip'])

    def test_a_survivor_deleted_later_on_the_branch_is_named(self) -> None:
        self.delete_test_removed('Deleted-test: test_removed => Kept')
        self.write('Box.Tests/Tests.cs', CS.replace('Kept', 'Renamed'))
        self.commit('rename\n\nDeleted-test: Kept => Renamed')
        self.assertEqual(cdt.problems(self.root, 'main'),
                         ['test_removed => Kept: the survivor is no test at the tip'])

    def test_a_mark_clears_the_deletion_when_a_mark_of_coding_standards_begins_with_it(self) -> None:
        self.delete_test_removed('Deleted-test: test_removed => mark: A test proves an absence')
        self.assertEqual(cdt.problems(self.root, 'main'), [])

    def test_a_mark_coding_standards_does_not_hold_is_named(self) -> None:
        self.delete_test_removed('Deleted-test: test_removed => mark: removed an absence')
        self.assertEqual(cdt.problems(self.root, 'main'),
                         ['test_removed => mark: removed an absence: no mark in CODING_STANDARDS.md begins so'])

    def test_a_trailer_without_its_arrow_is_named(self) -> None:
        self.delete_test_removed('Deleted-test: test_removed')
        self.assertEqual(cdt.problems(self.root, 'main'), [
            "Deleted-test: test_removed: reads '<deleted> => <survivor>' or '<deleted> => mark: <mark>'",
            "test_removed: deleted, and no 'Deleted-test:' trailer names it",
        ])


class Main(Repo):
    def test_it_prints_each_problem_with_the_count_and_fails_the_run(self) -> None:
        self.keep_only_the_kept_tests()
        self.write('scripts/tests/test_box.py', PY)
        self.commit('delete')
        status, printed = self.main()
        self.assertEqual((status, printed.splitlines()[-1]), (1, '--- 7 FINDINGS ON DELETED TESTS ---'))

    def test_it_passes_a_branch_that_deletes_nothing(self) -> None:
        self.assertEqual(self.main(), (0, '--- 0 FINDINGS ON DELETED TESTS ---\n'))


if __name__ == '__main__':
    unittest.main()
