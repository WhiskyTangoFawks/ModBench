"""Pins skips.py: a run's directory names every stack's skip."""
import contextlib
import io
import pathlib
import tempfile
import unittest

import report_fixtures as fx
import skips


class Main(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)

    def run_main(self):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            code = skips.main([str(self.dir)])
        return code, printed.getvalue()

    def test_it_names_every_stacks_skip_and_fails(self):
        (self.dir / 'a.trx').write_text(fx.trx(fx.trx_result('A.Ran'), fx.trx_result('A.Skipped', outcome='NotExecuted')))
        (self.dir / 'unit.json').write_text(fx.vitest(('/repo/modbench/src/a.test.ts', [('ran', 'passed', 3), ('skipped', 'pending', None)])))
        (self.dir / 'hooks.unittest').write_text(fx.unittest_log(skipped=['test_skipped (m.C.test_skipped)']))
        (self.dir / 'it.mocha').write_text(fx.mocha_log(pending=['skipped']))
        code, printed = self.run_main()
        self.assertEqual(
            (code, printed.splitlines()),
            (1, ['skipped  A.Skipped', 'skipped  test_skipped (m.C.test_skipped)', 'skipped  skipped',
                 'skipped  src/a.test.ts > skipped', '--- 4 TESTS SKIPPED ---']))

    def test_it_passes_when_nothing_skipped(self):
        (self.dir / 'a.trx').write_text(fx.trx(fx.trx_result('A.Ran')))
        self.assertEqual(self.run_main(), (0, ''))


if __name__ == '__main__':
    unittest.main()
