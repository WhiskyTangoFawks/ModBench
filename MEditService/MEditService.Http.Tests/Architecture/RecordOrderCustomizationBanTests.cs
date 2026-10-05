namespace MEditService.Http.Tests.Architecture;

public sealed class RecordOrderCustomizationBanTests
{
    [Fact]
    public void NoProductionSource_CallsEnforceRecordOrder()
    {
        var root = ServiceProjects.SolutionDirectory();
        var offenders = Directory
            .EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(IsProductionSource)
            .Where(file => File.ReadAllText(file).Contains(".EnforceRecordOrder(", StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(root, file))
            .ToList();

        Assert.True(
            offenders.Count == 0,
            $"Order is carried in the parent's ordered child list (ADR-0006), not in file " +
            $"names. Remove the .EnforceRecordOrder() call in: {string.Join(", ", offenders)}");
    }

    [Fact]
    public void TheScan_ActuallyReachesTheCustomizationItGuards()
    {
        var root = ServiceProjects.SolutionDirectory();
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
}
