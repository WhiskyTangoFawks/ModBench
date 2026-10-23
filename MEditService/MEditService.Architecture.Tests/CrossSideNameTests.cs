using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class CrossSideNameTests
{
    public sealed record Name(
        string BackendFile, string BackendPattern, string FrontendFile, string FrontendPattern,
        string PlantedBackend, string PlantedFrontend)
    {
        public override string ToString() => Path.GetFileNameWithoutExtension(BackendFile) + ": " + BackendPattern;
    }

    private const string Sources = "MEditService.SourceAdapter";

    public static TheoryData<Name> EveryName =>
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
        new(Path.Combine(Sources, "SourceRepositoryLayout.cs"),
            @"internal const string BuildConfigurationFileName = ""([^""]+)"";",
            Path.Combine("wire", "sourceMod.ts"),
            @"(?:export )?const BUILD_CONFIGURATION_FILE = '([^']+)';",
            "internal const string BuildConfigurationFileName = \"build.json\";",
            "export const BUILD_CONFIGURATION_FILE = 'builds.json';"),
        new(Path.Combine(Sources, "BuildConfiguration.cs"),
            @"const string OutputKey = ""([^""]+)"";",
            Path.Combine("wire", "sourceMod.ts"),
            @"(?:export )?const BUILD_OUTPUT_KEY = '([^']+)';",
            "private const string OutputKey = \"output\";",
            "export const BUILD_OUTPUT_KEY = 'outputFolder';"),
    ];

    [Theory]
    [MemberData(nameof(EveryName))]
    public void TheBackendAndFrontendNames_Agree(Name name)
    {
        var root = ServiceProjects.SolutionDirectory();
        var frontend = Path.Combine(root, "..", "modbench", "src", name.FrontendFile);

        Assert.Equal(
            ValueIn(Path.Combine(root, name.BackendFile), name.BackendPattern),
            ValueIn(frontend, name.FrontendPattern));
    }

    [Theory]
    [MemberData(nameof(EveryName))]
    public void TheScan_CatchesAPlantedMismatch(Name name)
    {
        using var dir = new ScratchDirectory("medit-cross-side-");
        var backend = Path.Combine(dir, "backend");
        var frontend = Path.Combine(dir, "frontend");
        File.WriteAllText(backend, name.PlantedBackend);
        File.WriteAllText(frontend, name.PlantedFrontend);

        Assert.NotEqual(ValueIn(backend, name.BackendPattern), ValueIn(frontend, name.FrontendPattern));
    }

    private static string ValueIn(string file, string pattern)
    {
        var match = Regex.Match(File.ReadAllText(file), pattern);
        return match.Success
            ? match.Groups[1].Value
            : throw new InvalidOperationException($"Expected '{file}' to declare the name matching {pattern}.");
    }
}
