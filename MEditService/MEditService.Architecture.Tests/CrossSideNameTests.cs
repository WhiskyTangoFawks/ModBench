using System.Text.RegularExpressions;

namespace MEditService.Architecture.Tests;

public sealed class CrossSideNameTests
{
    public sealed record BackendFrontendPair(
        string BackendFile, string BackendPattern, string FrontendFile, string FrontendPattern)
    {
        public override string ToString() => Path.GetFileNameWithoutExtension(BackendFile) + ": " + BackendPattern;
    }

    private const string Sources = "MEditService.SourceAdapter";

    public static TheoryData<BackendFrontendPair> EveryName =>
    [
        new(Path.Combine("MEditService.RepositoriesLib", "TempName.cs"),
            @"private const string Prefix = ""([^""]+)"";",
            Path.Combine("repositoriesLib", "wholeWrites.ts"),
            @"(?:export )?const TEMP_PREFIX = '([^']+)';"),
        new(Path.Combine(Sources, "SourceRepositoryLayout.cs"),
            @"internal const string RootFolderName = ""([^""]+)"";",
            Path.Combine("wire", "sourceMod.ts"),
            @"(?:export )?const PLUGIN_SOURCE_FOLDER = '([^']+)';"),
        new(Path.Combine(Sources, "SourceRepositoryLayout.cs"),
            @"internal const string BuildFileName = ""([^""]+)"";",
            Path.Combine("wire", "sourceMod.ts"),
            @"(?:export )?const BUILD_FILE = '([^']+)';"),
        new(Path.Combine("MEditService.RecordIndex", "Store", "IndexFile.cs"),
            @"private const string FolderName = ""([^""]+)"";",
            Path.Combine("instanceAdapter", "mo2", "layout.ts"),
            @"(?:export )?const RECORD_INDEX = '([^']+)';"),
    ];

    [Theory]
    [MemberData(nameof(EveryName))]
    public void TheBackendAndFrontendNames_Agree(BackendFrontendPair pair)
    {
        var root = ServiceProjects.SolutionDirectory();
        var frontend = Path.Combine(root, "..", "modbench", "src", pair.FrontendFile);

        Assert.Equal(
            ValueIn(Path.Combine(root, pair.BackendFile), pair.BackendPattern),
            ValueIn(frontend, pair.FrontendPattern));
    }

    private static string ValueIn(string file, string pattern)
    {
        var match = Regex.Match(File.ReadAllText(file), pattern);
        return match.Success
            ? match.Groups[1].Value
            : throw new InvalidOperationException($"Expected '{file}' to declare the name matching {pattern}.");
    }
}
