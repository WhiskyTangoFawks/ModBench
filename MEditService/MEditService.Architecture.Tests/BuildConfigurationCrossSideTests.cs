using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class BuildConfigurationCrossSideTests
{
    private static readonly Regex BackendFileName =
        new(@"internal const string BuildConfigurationFileName = ""([^""]+)"";", RegexOptions.Compiled);
    private static readonly Regex FrontendFileName =
        new(@"(?:export )?const BUILD_CONFIGURATION_FILE = '([^']+)';", RegexOptions.Compiled);
    private static readonly Regex BackendOutputKey =
        new(@"const string OutputKey = ""([^""]+)"";", RegexOptions.Compiled);
    private static readonly Regex FrontendOutputKey =
        new(@"(?:export )?const BUILD_OUTPUT_KEY = '([^']+)';", RegexOptions.Compiled);

    private static readonly string Root = ServiceProjects.SolutionDirectory();
    private static readonly string FrontendSourceMod = Path.Combine(Root, "..", "modbench", "src", "wire", "sourceMod.ts");

    [Fact]
    public void TheBackendAndFrontendFileNames_Agree() =>
        Assert.Equal(
            ValueIn(Path.Combine(Root, "MEditService.SourceAdapter", "SourceRepositoryLayout.cs"), BackendFileName),
            ValueIn(FrontendSourceMod, FrontendFileName));

    [Fact]
    public void TheBackendAndFrontendOutputKeys_Agree() =>
        Assert.Equal(
            ValueIn(Path.Combine(Root, "MEditService.SourceAdapter", "BuildConfiguration.cs"), BackendOutputKey),
            ValueIn(FrontendSourceMod, FrontendOutputKey));

    [Fact]
    public void TheScan_CatchesAPlantedOutputKeyMismatch()
    {
        using var dir = new ScratchDirectory("medit-build-configuration-cross-side-");
        var backendFile = Path.Combine(dir, "BuildConfiguration.cs");
        var frontendFile = Path.Combine(dir, "sourceMod.ts");
        File.WriteAllText(backendFile, "private const string OutputKey = \"output\";");
        File.WriteAllText(frontendFile, "export const BUILD_OUTPUT_KEY = 'outputFolder';");

        Assert.NotEqual(ValueIn(backendFile, BackendOutputKey), ValueIn(frontendFile, FrontendOutputKey));
    }

    [Fact]
    public void TheScan_CatchesAPlantedFileNameMismatch()
    {
        using var dir = new ScratchDirectory("medit-build-configuration-cross-side-");
        var backendFile = Path.Combine(dir, "SourceRepositoryLayout.cs");
        var frontendFile = Path.Combine(dir, "sourceMod.ts");
        File.WriteAllText(backendFile, "internal const string BuildConfigurationFileName = \"build.json\";");
        File.WriteAllText(frontendFile, "export const BUILD_CONFIGURATION_FILE = 'builds.json';");

        Assert.NotEqual(ValueIn(backendFile, BackendFileName), ValueIn(frontendFile, FrontendFileName));
    }

    private static string ValueIn(string file, Regex pattern)
    {
        var match = pattern.Match(File.ReadAllText(file));
        return match.Success
            ? match.Groups[1].Value
            : throw new InvalidOperationException($"Expected '{file}' to declare the build configuration's name.");
    }
}
