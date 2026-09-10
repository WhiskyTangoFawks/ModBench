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

    // Zero offenders and zero files walked read the same: a BridgeSourceDirectory that resolved to
    // an empty or vanished folder would still pass the assertion above.
    [Fact]
    public void TheScan_WalksAtLeastOneBridgeSourceFile()
    {
        var walked = SourceFiles(BridgeSourceDirectory()).Count;

        Assert.True(walked >= 1, $"The bridge scan walked {walked} files under {BridgeSourceDirectory()}.");
    }

    // Internal so a rival can be applied to and removed from a file copy without touching git state.
    internal static List<string> ScanBridgeSources(string bridgeSourceDirectory)
    {
        var offenders = new List<string>();
        foreach (var file in SourceFiles(bridgeSourceDirectory))
        {
            var text = File.ReadAllText(file);
            foreach (var ns in ForbiddenNamespaces)
            {
                if (text.Contains(ns, StringComparison.Ordinal))
                    offenders.Add($"{Path.GetFileName(file)} references {ns}");
            }
        }
        return offenders;
    }

    // Proves the walk through the same matcher the assertion above calls: a planted reference to a
    // forbidden namespace, under a nested subdirectory, is caught.
    [Fact]
    public void TheScan_FindsAPlantedForbiddenNamespaceReference()
    {
        var root = Directory.CreateTempSubdirectory("medit-bridge-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Nested"));
            File.WriteAllText(Path.Combine(root, "Nested", "Planted.cs"), "using MEditService.Core.Plugins;\n");
            File.WriteAllText(Path.Combine(root, "Clean.cs"), "using MEditService.Core.Source;\n");

            Assert.Equal(["Planted.cs references MEditService.Core.Plugins"], ScanBridgeSources(root));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static List<string> SourceFiles(string bridgeSourceDirectory) =>
        [.. Directory.EnumerateFiles(bridgeSourceDirectory, "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))];

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
