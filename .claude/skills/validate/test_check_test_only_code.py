"""Pins check_test_only_code.py: a production member named by a test project and by no other production
code is reported, and fails the run."""
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

    def test_a_type_whose_base_production_tests_assignability_to_is_not_reported_and_one_with_another_base_is(self) -> None:
        self.project('Box', 'internal sealed class FoundAssignableTo : IRule\n{\n}\n'
                            'internal sealed class FoundAssignableFrom : IOther, IDisposable\n{\n}\n'
                            'internal sealed class FromBase(int a) : Base(a)\n{\n}\n'
                            'class Finder { bool[] all = [t.IsAssignableTo(typeof(IRule)), typeof(IOther).IsAssignableFrom(t)];'
                            ' Type b = typeof(Base); }', uses='Finder')
        self.project('Box.Tests', 'class T { object[] all = [typeof(FoundAssignableTo), typeof(FoundAssignableFrom), typeof(FromBase)]; }')
        self.assertEqual(self.reported(), ['FromBase'])

    def test_a_static_class_is_reached_through_its_members_so_only_they_are_reported(self) -> None:
        self.project('Box', 'public static class Registration {\n'
                            '    public static int AddBox(this object services) => 1;\n'
                            '    public static int OnlyTests(this object services) => 2;\n}\n'
                            'class Host { int n = new object().AddBox(); }', uses='Host')
        self.project('Box.Tests', 'class T { object[] all = [typeof(Registration), new object().OnlyTests()]; }')
        self.assertEqual(self.reported(), ['OnlyTests'])

    def test_a_test_side_declaration_of_the_same_name_is_not_a_reach(self) -> None:
        self.project('Box', 'public class Box {\n    public int Stop() => 1;\n}', uses='Box')
        self.project('Box.Tests', 'class Fake {\n    public int Stop() => 2;\n}')
        self.assertEqual(self.reported(), [])

    def test_a_parameter_named_record_does_not_hide_its_method(self):
        self.project('Box', 'public class Box {\n    public void OnlyTests(IMajorRecord record)\n    {\n    }\n}', uses='Box')
        self.project('Box.Tests', 'class T { void Run() { new Box().OnlyTests(null); } }')
        self.assertEqual(self.reported(), ['OnlyTests'])

    def test_overloads_are_one_name_with_each_file(self):
        self.project('Box', 'public class Box {\n    public int OnlyTests() => 1;\n    public int OnlyTests(int n) => n;\n}', uses='Box')
        self.project('Box.Tests', 'class T { int n = new Box().OnlyTests(1); }')
        self.assertEqual([(member.name, member.files) for member in ctoc.test_only_members(self.root)], [('OnlyTests', ['Box/Source.cs'])])

    def test_build_output_is_not_source(self):
        self.project('Box', 'public class Box {\n}', uses='Box')
        (self.root / 'Box/obj').mkdir()
        (self.root / 'Box/obj/Generated.cs').write_text('public class Generated {\n    public int OnlyTests() => 1;\n}')
        self.project('Box.Tests', 'class T { int n = new Generated().OnlyTests(); }')
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

    def test_it_names_each_member_with_its_file_and_counts_them_and_fails_the_run(self) -> None:
        self.project('Box', 'public class Box {\n    public int OnlyTests() => 1;\n}', uses='Box')
        self.project('Box.Tests', 'class T { int n = new Box().OnlyTests(); }')
        status, printed = self.main()
        self.assertIn('OnlyTests  Box/Source.cs', printed)
        self.assertIn('--- 1 MEMBERS ONLY TESTS REACH ---', printed)
        self.assertEqual(status, 1)

    def test_nothing_only_tests_reach_passes_the_run(self) -> None:
        self.project('Box', 'public class Box {\n    public int Used() => 1;\n}', uses='Box')
        self.project('Box.Tests', 'class T { }')
        self.assertEqual(self.main()[0], 0)


if __name__ == '__main__':
    unittest.main()
