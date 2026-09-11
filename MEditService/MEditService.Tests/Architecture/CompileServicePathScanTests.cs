using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>Compile takes its files from the repository and hands them to the whole-mod door, so the
/// service itself touches no disk. One file rather than the whole Edits folder, whose own scan
/// arrives later.</summary>
public sealed class CompileServicePathScanTests
{
    private const string CompileServiceFile = "MEditService.Core/Edits/PluginCompileService.cs";

    // Neither a member named RelativePath nor a property reached as edit.Path is a BCL call: only
    // the three types as their own unqualified identifiers are operations.
    private static readonly Regex Operation =
        new(@"(?<![\w.])(Path|File|Directory)\.([A-Za-z]+)", RegexOptions.Compiled);

    [Fact]
    public void TheCompileService_NamesNoPathFileOrDirectoryOperation()
    {
        var root = ArchitectureTests.SolutionDirectory();

        Assert.Empty(OperationsIn(root, CompileServiceFile));
    }

    [Fact]
    public void TheScan_NamesAPlantedOperation_AndPassesTheCallsThatAreNotOne()
    {
        var root = Directory.CreateTempSubdirectory("medit-compile-path-scan-").FullName;
        try
        {
            var planted = Path.Combine(root, CompileServiceFile.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(planted)!);
            File.WriteAllText(
                planted,
                "var tree = Path.Combine(modFolder, root);\n"
                + "var held = File.ReadAllBytes(unit.FullPath);\n"
                + "var anchored = file.RelativePath.Equals(other.RelativePath);\n"
                + "if (edit.Path.Count == 0) return;\n");

            Assert.Equal(["Path.Combine", "File.ReadAllBytes"], OperationsIn(root, CompileServiceFile));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static List<string> OperationsIn(string root, string relativePath) =>
        [.. Operation
            .Matches(File.ReadAllText(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar))))
            .Select(match => match.Value)];
}
