using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

/// <summary>Record comparison goes through <c>ModelIdentity</c>, never Mutagen's generated equality: the
/// generated comparers lie in both directions (upstream #685/#686) and the pin stays 0.53.1.</summary>
public sealed class ComparisonDoorBoundaryTests
{
    [Fact]
    public void GeneratedEqualityMask_IsOnlyConsultedByModelIdentity()
    {
        var offenders = new[]
        {
            "MEditService.Codec", "MEditService.Commands", "MEditService.Http", "MEditService.Index",
            "MEditService.LoadOrder", "MEditService.PluginAdapter", "MEditService.Ports",
            "MEditService.Queries", "MEditService.SourceAdapter", "MEditService.Watcher",
        }
            .Select(FindProjectSourceRoot)
            .SelectMany(ScanForMaskConsultation)
            .ToList();

        Assert.Empty(offenders);
    }

    private static IEnumerable<string> ScanForMaskConsultation(string projectRoot)
    {
        return Directory.EnumerateFiles(projectRoot, "*.cs", SearchOption.AllDirectories)
            .Where(f => !Path.GetFileName(f).Equals("ModelIdentity.cs", StringComparison.Ordinal))
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(f =>
            {
                var text = File.ReadAllText(f);
                return text.Contains("GetEqualsMask", StringComparison.Ordinal)
                    || text.Contains("EqualsMaskHelper", StringComparison.Ordinal);
            })
            .Select(Path.GetFileName)
            .OfType<string>();
    }

    private static string FindProjectSourceRoot(string projectName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, projectName)))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir.FullName, projectName);
    }
}
