namespace MEditService.Tests.Bridge;

/// <summary>Scans source text rather than the assembly: reflection sees only types the bridge uses, so a
/// reference optimized away or in an uncalled method would pass silently (ADR-0041).</summary>
public sealed class BridgeKnowsNothingOfLoadOrdersTests
{
    private static readonly string[] ForbiddenNamespaces =
    [
        "MEditService.Core.Plugins",
        "MEditService.Core.Records",
    ];

    [Fact]
    public void NoBridgeSourceFile_ReferencesPluginsOrRecordsNamespaces()
    {
        var offenders = ScanBridgeSources(BridgeSourceDirectory());

        Assert.True(offenders.Count == 0,
            $"Bridge source file(s) reference a forbidden namespace: {string.Join(", ", offenders)}");
    }

    internal static List<string> ScanBridgeSources(string bridgeSourceDirectory)
    {
        var offenders = new List<string>();
        foreach (var file in Directory.EnumerateFiles(bridgeSourceDirectory, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)) continue;
            if (file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)) continue;

            var text = File.ReadAllText(file);
            foreach (var ns in ForbiddenNamespaces)
            {
                if (text.Contains(ns, StringComparison.Ordinal))
                    offenders.Add($"{Path.GetFileName(file)} references {ns}");
            }
        }
        return offenders;
    }

    internal static string BridgeSourceDirectory()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "MEditService.sln")))
            dir = dir.Parent;

        if (dir == null)
            throw new InvalidOperationException("Could not locate MEditService.sln above the test output directory.");

        return Path.Combine(dir.FullName, "MEditService.Bridge");
    }
}
