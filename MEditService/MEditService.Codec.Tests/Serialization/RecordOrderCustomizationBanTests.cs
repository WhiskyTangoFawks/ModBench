namespace MEditService.Codec.Tests.Serialization;

/// <summary>A source-text ban, not one deleted line: record type names collide across games, so one
/// generator compilation seeds one game and each game needs its own seed class the flag could
/// reappear in.</summary>
public sealed class RecordOrderCustomizationBanTests
{
    [Fact]
    public void NoProductionSource_CallsEnforceRecordOrder()
    {
        var root = RepositoryRoot();
        var offenders = Directory
            .EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(IsProductionSource)
            .Where(file => File.ReadAllText(file).Contains(".EnforceRecordOrder(", StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(root, file))
            .ToList();

        Assert.True(
            offenders.Count == 0,
            $"Order is carried in the parent's ordered child list (ADR-0006 decision 4), not in file " +
            $"names. Remove the .EnforceRecordOrder() call in: {string.Join(", ", offenders)}");
    }

    [Fact]
    public void TheScan_ActuallyReachesTheCustomizationItGuards()
    {
        var root = RepositoryRoot();
        var scanned = Directory
            .EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(IsProductionSource)
            .Select(Path.GetFileName)
            .ToList();

        Assert.Contains("RecordTextCodecCustomization.cs", scanned, StringComparer.Ordinal);
    }

    private static bool IsProductionSource(string file)
    {
        var segments = file.Split(Path.DirectorySeparatorChar);
        return !segments.Contains("obj", StringComparer.Ordinal)
            && !segments.Contains("bin", StringComparer.Ordinal)
            && !segments.Any(s => s.EndsWith(".Tests", StringComparison.Ordinal));
    }

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "MEditService.sln"))) return directory.FullName;
        }

        throw new InvalidOperationException(
            "Could not find MEditService.sln above the test assembly — this guard cannot scan what it cannot locate.");
    }
}
