"""Pins check_test_only_code.py: a production member named by a test project and by no other production
code is reported, and nothing fails."""
import contextlib
import io
import pathlib
import tempfile
import unittest

import check_test_only_code as ctoc


class Solution(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)

    def project(self, name: str, source: str, uses: str = '') -> None:
        """A project's source, and the types its other code names without declaring them."""
        folder = self.root / name
        folder.mkdir(exist_ok=True)
        (folder / f'{name}.csproj').write_text('<Project />')
        (folder / 'Source.cs').write_text(source)
        (folder / 'Uses.cs').write_text(f'class Uses {{ object[] types = [{uses}]; }}')

    def reported(self) -> list[str]:
        return [member.name for member in ctoc.test_only_members(self.root)]


class Members(Solution):
    def test_a_method_only_a_test_calls_is_reported_and_one_production_code_calls_is_not(self):
        self.project('Box', 'public class Box {\n    public int Used() => 1;\n    public int OnlyTests() => 2;\n}\n'
                            'public class Caller {\n    int n = new Box().Used();\n}', uses='Caller')
        self.project('Box.Tests', 'class T { void Run() { new Box().OnlyTests(); new Box().Used(); } }')
        self.assertEqual(self.reported(), ['OnlyTests'])

    def test_each_kind_of_declaration_is_read(self):
        self.project('Box', 'public sealed record TypeOnlyTests(int A);\n'
                            'internal static class Holder {\n'
                            '    internal static readonly string FieldOnlyTests = "";\n'
                            '    public string PropertyOnlyTests { get; init; }\n'
                            '    public static async Task<List<int>> GenericOnlyTests<T>(T x) => [];\n'
                            '}', uses='Holder')
        self.project('Box.Tests', 'class T { object[] All = [typeof(TypeOnlyTests), Holder.FieldOnlyTests, '
                                  'Holder.PropertyOnlyTests, Holder.GenericOnlyTests(1)]; }')
        self.assertEqual(sorted(self.reported()), ['FieldOnlyTests', 'GenericOnlyTests', 'PropertyOnlyTests', 'TypeOnlyTests'])

    def test_a_member_no_test_names_is_not_reported(self):
        self.project('Box', 'public class Box {\n    public int Nobody() => 1;\n}', uses='Box')
        self.project('Box.Tests', 'class T { }')
        self.assertEqual(self.reported(), [])

    def test_a_comment_in_production_is_not_a_reach_but_an_interpolated_string_is(self):
        self.project('Box', 'public class Box {\n    public int OnlyTests() => 1; // OnlyTests\n    public int Interpolated() => 1; /* Interpolated */\n'
                            '    string s = $"{Interpolated()}";\n}', uses='Box')
        self.project('Box.Tests', 'class T { void Run() { new Box().OnlyTests(); new Box().Interpolated(); } }')
        self.assertEqual(self.reported(), ['OnlyTests'])

    def test_a_name_only_part_of_a_longer_identifier_is_not_a_reach(self):
        self.project('Box', 'public class Box {\n    public int Read() => 1;\n    public int ReadAll() => Read();\n}', uses='Box')
        self.project('Box.Tests', 'class T { void Run() { new Box().ReadAll(); } }')
        self.assertEqual(self.reported(), ['ReadAll'])

    def test_an_interface_member_is_a_name_in_production_so_its_implementation_is_not_reported(self):
        self.project('Box', 'public interface IBox {\n    int OnlyTests();\n}\npublic class Box : IBox {\n    public int OnlyTests() => 1;\n}', uses='Box, IBox')
        self.project('Box.Tests', 'class T { int n = new Box().OnlyTests(); }')
        self.assertEqual(self.reported(), [])

    def test_an_override_is_not_a_declaration(self):
        self.project('Box', 'public class Box {\n    public override string ToString() => "";\n}', uses='Box')
        self.project('Box.Tests', 'class T { string s = new Box().ToString(); }')
        self.assertEqual(self.reported(), [])

    def test_a_member_of_the_test_side_is_not_production(self):
        self.project('Box.TestSupport', 'public class Fixture {\n    public int Helper() => 1;\n}')
        self.project('Box.Tests', 'class T { int n = new Fixture().Helper(); }')
        self.assertEqual(self.reported(), [])

    def test_the_member_names_its_file(self):
        self.project('Box', 'public class Box {\n    public int OnlyTests() => 1;\n}', uses='Box')
        self.project('Box.Tests', 'class T { int n = new Box().OnlyTests(); }')
        self.assertEqual([member.files for member in ctoc.test_only_members(self.root)], [['Box/Source.cs']])


class Main(Solution):
    def main(self) -> tuple[int, str]:
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            status = ctoc.main([str(self.root)])
        return status, printed.getvalue()

    def test_it_names_each_member_with_its_file_and_counts_them_and_fails_nothing(self):
        self.project('Box', 'public class Box {\n    public int OnlyTests() => 1;\n}', uses='Box')
        self.project('Box.Tests', 'class T { int n = new Box().OnlyTests(); }')
        status, printed = self.main()
        self.assertIn('OnlyTests  Box/Source.cs', printed)
        self.assertIn('--- 1 MEMBERS ONLY TESTS REACH ---', printed)
        self.assertEqual(status, 0)


if __name__ == '__main__':
    unittest.main()
