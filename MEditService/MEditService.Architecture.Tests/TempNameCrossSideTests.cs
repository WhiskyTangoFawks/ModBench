using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class TempNameCrossSideTests
{
    private static readonly Regex BackendValue =
        new(@"private const string Prefix = ""([^""]+)"";", RegexOptions.Compiled);
    private static readonly Regex FrontendValue =
        new(@"(?:export )?const TEMP_PREFIX = '([^']+)';", RegexOptions.Compiled);

    [Fact]
    public void TheBackendAndFrontendPrefixes_Agree()
    {
        var root = ServiceProjects.SolutionDirectory();
        var backendFile = Path.Combine(root, "MEditService.RepositoriesLib", "TempName.cs");
        var frontendFile = Path.Combine(root, "..", "modbench", "src", "instanceAdapter", "files.ts");

        Assert.Equal(ValueIn(backendFile, BackendValue), ValueIn(frontendFile, FrontendValue));
    }

    [Fact]
    public void TheScan_CatchesAPlantedMismatch()
    {
        using var dir = new ScratchDirectory("medit-temp-name-cross-side-");
        var backendFile = Path.Combine(dir, "TempName.cs");
        var frontendFile = Path.Combine(dir, "files.ts");
        File.WriteAllText(backendFile, "private const string Prefix = \".medit_tmp_\";");
        File.WriteAllText(frontendFile, "const TEMP_PREFIX = '.medit_temp_';");

        Assert.NotEqual(ValueIn(backendFile, BackendValue), ValueIn(frontendFile, FrontendValue));
    }

    private static string ValueIn(string file, Regex pattern)
    {
        var match = pattern.Match(File.ReadAllText(file));
        return match.Success
            ? match.Groups[1].Value
            : throw new InvalidOperationException($"Expected '{file}' to declare the temp name prefix.");
    }
}
