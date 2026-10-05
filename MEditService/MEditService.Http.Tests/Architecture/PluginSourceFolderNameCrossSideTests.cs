using System.Text.RegularExpressions;

namespace MEditService.Http.Tests.Architecture;

public sealed class PluginSourceFolderNameCrossSideTests
{
    private static readonly Regex BackendValue =
        new(@"internal const string RootFolderName = ""([^""]+)"";", RegexOptions.Compiled);
    private static readonly Regex FrontendValue =
        new(@"export const PLUGIN_SOURCE_FOLDER = '([^']+)';", RegexOptions.Compiled);

    [Fact]
    public void TheBackendAndFrontendNames_Agree()
    {
        var root = ServiceProjects.SolutionDirectory();
        var backendFile = Path.Combine(root, "MEditService.SourceAdapter", "SourceRepositoryLayout.cs");
        var frontendFile = Path.Combine(root, "..", "modbench", "src", "instanceAdapter", "layout.ts");

        Assert.Equal(ValueIn(backendFile, BackendValue), ValueIn(frontendFile, FrontendValue));
    }

    [Fact]
    public void TheScan_CatchesAPlantedMismatch()
    {
        var dir = Directory.CreateTempSubdirectory("medit-plugin-source-cross-side-").FullName;
        try
        {
            var backendFile = Path.Combine(dir, "SourceRepositoryLayout.cs");
            var frontendFile = Path.Combine(dir, "layout.ts");
            File.WriteAllText(backendFile, "internal const string RootFolderName = \"plugin-source\";");
            File.WriteAllText(frontendFile, "export const PLUGIN_SOURCE_FOLDER = 'source';");

            Assert.NotEqual(ValueIn(backendFile, BackendValue), ValueIn(frontendFile, FrontendValue));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static string ValueIn(string file, Regex pattern)
    {
        var match = pattern.Match(File.ReadAllText(file));
        return match.Success
            ? match.Groups[1].Value
            : throw new InvalidOperationException($"Expected '{file}' to declare the plugin source folder name.");
    }
}
