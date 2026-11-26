"""Pins check_test_data.py: each file in a test-data folder over the limit is named with its size, and nothing fails."""
import contextlib
import io
import pathlib
import tempfile
import unittest

import check_test_data as ctd


class Tree(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)

    def write(self, path: str, size: int) -> None:
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'x' * size)

    def main(self) -> tuple[int, str]:
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            status = ctd.main([str(self.root)])
        return status, printed.getvalue()


class Over(Tree):
    def test_a_file_in_a_test_data_folder_is_named_with_its_size_when_over_the_limit_and_not_at_it(self):
        self.write('Box.Tests/TestData/at.bin', ctd.LIMIT_BYTES)
        self.write('Box.Tests/TestData/over.bin', ctd.LIMIT_BYTES + 1)
        self.assertEqual(ctd.over_limit(self.root), [('Box.Tests/TestData/over.bin', ctd.LIMIT_BYTES + 1)])

    def test_every_kind_of_test_data_folder_is_read(self):
        for folder in ('TestData', 'fixtures', 'goldens'):
            self.write(f'a/{folder}/deep/big.json', ctd.LIMIT_BYTES + 1)
        self.assertEqual(len(ctd.over_limit(self.root)), 3)

    def test_a_large_file_outside_a_test_data_folder_is_not_test_data(self):
        self.write('modbench/package-lock.json', ctd.LIMIT_BYTES + 1)
        self.assertEqual(ctd.over_limit(self.root), [])

    def test_a_file_named_like_a_test_data_folder_is_not_in_one(self):
        self.write('Box/TestData', ctd.LIMIT_BYTES + 1)
        self.assertEqual(ctd.over_limit(self.root), [])

    def test_build_output_dependencies_and_references_are_not_read(self):
        for folder in ('node_modules', 'bin', 'obj', 'references', '.vscode-test', 'vendor'):
            self.write(f'{folder}/TestData/big.bin', ctd.LIMIT_BYTES + 1)
        self.assertEqual(ctd.over_limit(self.root), [])

    def test_the_largest_comes_first(self):
        self.write('TestData/a.bin', ctd.LIMIT_BYTES + 1)
        self.write('TestData/b.bin', ctd.LIMIT_BYTES * 3)
        self.assertEqual([name for name, _ in ctd.over_limit(self.root)], ['TestData/b.bin', 'TestData/a.bin'])

    def test_a_non_ascii_name_is_read_whole(self):
        self.write("TestData/Ünïcode's.bin", ctd.LIMIT_BYTES + 1)
        self.assertEqual([name for name, _ in ctd.over_limit(self.root)], ["TestData/Ünïcode's.bin"])


class Main(Tree):
    def test_it_prints_each_file_over_the_limit_in_kilobytes_with_the_count(self):
        self.write('TestData/big.bin', 750 * 1024)
        self.write('TestData/small.bin', 10)
        _, printed = self.main()
        self.assertIn('750.0 KB  TestData/big.bin', printed)
        self.assertNotIn('small.bin', printed)
        self.assertIn('--- 1 TEST DATA FILES OVER 64 KB ---', printed)

    def test_it_fails_nothing(self):
        self.write('TestData/big.bin', ctd.LIMIT_BYTES + 1)
        self.assertEqual(self.main()[0], 0)


if __name__ == '__main__':
    unittest.main()
