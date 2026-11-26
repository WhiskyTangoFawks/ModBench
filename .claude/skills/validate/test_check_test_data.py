"""Pins check_test_data.py: each committed file in a test-data folder over the limit is named with its size, and nothing fails."""
import contextlib
import io
import pathlib
import subprocess
import tempfile
import unittest

import check_test_data as ctd


class CommittedData(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = pathlib.Path(self.tmp.name)
        self.git('init', '-q')

    def git(self, *args: str) -> None:
        subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True)

    def commit(self, path: str, size: int) -> None:
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'x' * size)
        self.git('add', path)

    def main(self) -> tuple[int, str]:
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            status = ctd.main([str(self.repo)])
        return status, printed.getvalue()


class Over(CommittedData):
    def test_a_file_in_a_test_data_folder_is_named_with_its_size_when_over_the_limit_and_not_at_it(self):
        self.commit('Box.Tests/TestData/at.bin', ctd.LIMIT_BYTES)
        self.commit('Box.Tests/TestData/over.bin', ctd.LIMIT_BYTES + 1)
        self.assertEqual(ctd.over_limit(self.repo), [('Box.Tests/TestData/over.bin', ctd.LIMIT_BYTES + 1)])

    def test_every_kind_of_test_data_folder_is_read(self):
        for folder in ('TestData', 'fixtures', 'goldens'):
            self.commit(f'a/{folder}/deep/big.json', ctd.LIMIT_BYTES + 1)
        self.assertEqual(len(ctd.over_limit(self.repo)), 3)

    def test_a_large_file_outside_a_test_data_folder_is_not_test_data(self):
        self.commit('modbench/package-lock.json', ctd.LIMIT_BYTES + 1)
        self.assertEqual(ctd.over_limit(self.repo), [])

    def test_a_file_that_is_not_committed_is_not_read(self):
        (self.repo / 'TestData').mkdir()
        (self.repo / 'TestData/loose.bin').write_bytes(b'x' * (ctd.LIMIT_BYTES + 1))
        self.assertEqual(ctd.over_limit(self.repo), [])

    def test_the_largest_comes_first(self):
        self.commit('TestData/a.bin', ctd.LIMIT_BYTES + 1)
        self.commit('TestData/b.bin', ctd.LIMIT_BYTES * 3)
        self.assertEqual([name for name, _ in ctd.over_limit(self.repo)], ['TestData/b.bin', 'TestData/a.bin'])

    def test_a_non_ascii_name_is_read_whole(self):
        self.commit("TestData/Ünïcode's.bin", ctd.LIMIT_BYTES + 1)
        self.assertEqual([name for name, _ in ctd.over_limit(self.repo)], ["TestData/Ünïcode's.bin"])


class Main(CommittedData):
    def test_it_prints_each_file_over_the_limit_in_kilobytes_with_the_count(self):
        self.commit('TestData/big.bin', 750 * 1024)
        self.commit('TestData/small.bin', 10)
        _, printed = self.main()
        self.assertIn('750.0 KB  TestData/big.bin', printed)
        self.assertNotIn('small.bin', printed)
        self.assertIn('--- 1 TEST DATA FILES OVER 64 KB ---', printed)

    def test_it_fails_nothing(self):
        self.commit('TestData/big.bin', ctd.LIMIT_BYTES + 1)
        self.assertEqual(self.main()[0], 0)


if __name__ == '__main__':
    unittest.main()
