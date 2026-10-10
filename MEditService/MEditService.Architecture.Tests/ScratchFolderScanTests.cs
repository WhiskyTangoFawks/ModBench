using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class ScratchFolderScanTests
{
    private const string ScratchHome = "MEditService.TestSupport/ScratchDirectory.cs";

    private static readonly string[] RawScratchFolders =
        [@"\bCreateTempSubdirector[y]\b", @"Path\.Combine\(\s*Path\.GetTempPath\(\)"];

    [Fact]
    public void ATestProject_MakesScratchFoldersOnlyThroughScratchDirectory()
    {
        var root = ServiceProjects.SolutionDirectory();

        var raw = RawScratchFolderFiles(root, ServiceProjects.TestSide(root));

        Assert.True(
            raw.Count == 0,
            $"A test project makes a scratch folder by hand. Use ScratchDirectory ({ScratchHome}), "
            + "which every test disposes the same way:\n" + string.Join("\n", raw));
    }

    [Fact]
    public void TheScan_NamesAFolderMadeByHand_AndPassesScratchDirectoryItself()
    {
        using var root = new ScratchDirectory("medit-scratch-folder-scan-");
        WriteFile(root, "MEditService.A.Tests/Rival.cs", "var dir = Directory.CreateTempSubdirectory(\"x-\");\n");
        WriteFile(root, "MEditService.A.Tests/Hand.cs", "var dir = Path.Combine(Path.GetTempPath(), $\"x-{Guid.NewGuid():N}\");\n");
        WriteFile(root, "MEditService.A.Tests/Clean.cs", "using var dir = new ScratchDirectory(\"x-\");\n");
        WriteFile(root, ScratchHome, "public string Path { get; } = Directory.CreateTempSubdirectory(prefix).FullName;\n");

        Assert.Equal(
            ["MEditService.A.Tests/Hand.cs", "MEditService.A.Tests/Rival.cs"],
            RawScratchFolderFiles(root, ["MEditService.A.Tests", "MEditService.TestSupport"]));
    }

    private static void WriteFile(string root, string relativePath, string text)
    {
        var path = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        File.WriteAllText(path, text);
    }

    private static List<string> RawScratchFolderFiles(string root, IReadOnlyList<string> projects) =>
        [.. projects
            .SelectMany(project => SourceTree.CSharpFiles(ServiceProjects.Folder(root, project)))
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Where(file => file != ScratchHome && !file.EndsWith(nameof(ScratchFolderScanTests) + ".cs", StringComparison.Ordinal))
            .Where(file => RawScratchFolders.Any(needle => Regex.IsMatch(File.ReadAllText(Path.Combine(root, file)), needle)))
            .Order(StringComparer.Ordinal)];
}
