using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class CrossSideNameTests
{
    public sealed record BackendFrontendPair(
        string BackendFile, string BackendPattern, string FrontendFile, string FrontendPattern,
        string PlantedBackend, string PlantedFrontend)
    {
        public override string ToString() => Path.GetFileNameWithoutExtension(BackendFile) + ": " + BackendPattern;
    }

    private const string Sources = "MEditService.SourceAdapter";

    public static TheoryData<BackendFrontendPair> EveryName =>
    [
        new(Path.Combine("MEditService.RepositoriesLib", "TempName.cs"),
            @"private const string Prefix = ""([^""]+)"";",
            Path.Combine("instanceAdapter", "files.ts"),
            @"(?:export )?const TEMP_PREFIX = '([^']+)';",
            "private const string Prefix = \".medit_tmp_\";",
            "const TEMP_PREFIX = '.medit_temp_';"),
        new(Path.Combine(Sources, "SourceRepositoryLayout.cs"),
            @"internal const string RootFolderName = ""([^""]+)"";",
            Path.Combine("wire", "sourceMod.ts"),
            @"(?:export )?const PLUGIN_SOURCE_FOLDER = '([^']+)';",
            "internal const string RootFolderName = \"plugin-source\";",
            "const PLUGIN_SOURCE_FOLDER = 'source';"),
        new(Path.Combine("MEditService.RepositoriesLib", "ManifestName.cs"),
            @"private const string Suffix = ""([^""]+)"";",
            Path.Combine("wire", "sourceMod.ts"),
            @"(?:export )?const MANIFEST_SUFFIX = '([^']+)';",
            "private const string Suffix = \".manifest.json\";",
            "export const MANIFEST_SUFFIX = '.manifest';"),
        new(Path.Combine("MEditService.RecordIndex", "Store", "IndexFile.cs"),
            @"private const string FolderName = ""([^""]+)"";",
            Path.Combine("instanceAdapter", "mo2", "layout.ts"),
            @"(?:export )?const RECORD_INDEX = '([^']+)';",
            "private const string FolderName = \"modbench\";",
            "const RECORD_INDEX = 'medit';"),
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

    [Theory]
    [MemberData(nameof(EveryName))]
    public void TheScan_CatchesAPlantedMismatch(BackendFrontendPair pair)
    {
        using var dir = new ScratchDirectory("medit-cross-side-");
        var backend = Path.Combine(dir, "backend");
        var frontend = Path.Combine(dir, "frontend");
        File.WriteAllText(backend, pair.PlantedBackend);
        File.WriteAllText(frontend, pair.PlantedFrontend);

        Assert.NotEqual(ValueIn(backend, pair.BackendPattern), ValueIn(frontend, pair.FrontendPattern));
    }

    private static string ValueIn(string file, string pattern)
    {
        var match = Regex.Match(File.ReadAllText(file), pattern);
        return match.Success
            ? match.Groups[1].Value
            : throw new InvalidOperationException($"Expected '{file}' to declare the name matching {pattern}.");
    }
}
