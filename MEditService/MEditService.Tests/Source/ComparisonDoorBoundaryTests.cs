namespace MEditService.Tests.Source;

/// <summary>
/// #669's boundary rule, pinned the same way the context-boundary tests pin theirs: record
/// comparison goes through our own door (<c>ModelIdentity</c>), never Mutagen's generated equality
/// — the generated comparers lie in both directions (upstream reports #685/#686 and PRs #689/#690
/// closed by our own withdrawal, #528/#614 investigated) and the pin stays 0.53.1, so no production code may consult
/// <c>GetEqualsMask</c>/<c>EqualsMaskHelper</c> anywhere else. Generated <c>Equals</c> on records
/// is not textually pinnable (every <c>.Equals(</c> in C# looks alike); production was verified
/// call-site-free on 2026-09-01 and stays a review concern — this test owns the half a scan can
/// own.
/// </summary>
public sealed class ComparisonDoorBoundaryTests
{
    [Fact]
    public void GeneratedEqualityMask_IsOnlyConsultedByModelIdentity()
    {
        var offenders = new[] { "MEditService.Core", "MEditService.Api", "MEditService.Bridge" }
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

    /// <summary>A production project's source directory, walked up from the test binary's own
    /// location — the same repo layout every gate command already depends on.</summary>
    private static string FindProjectSourceRoot(string projectName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, projectName)))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, projectName);
    }
}
