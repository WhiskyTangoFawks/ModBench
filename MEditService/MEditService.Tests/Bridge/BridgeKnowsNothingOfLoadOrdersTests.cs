namespace MEditService.Tests.Bridge;

/// <summary>
/// <c>MEditService.Bridge</c> exists so "knowing nothing of mirror or the DB" (ADR-0041)
/// is a fact this test can catch, not a discipline a reviewer has to remember. Every mechanic the
/// bridge needs (classification, plumbing commit, rebase, the deferral marker) lives in
/// <c>MEditService.Core.Source</c> instead — already load order/DB-free by the same construction as
/// <c>SourceRepository</c>/<c>CompileJournal</c>/<c>SourceFreshness</c> — so the bridge project
/// itself should never need to reference <c>MEditService.Core.Plugins</c> or
/// <c>MEditService.Core.Records</c> at all.
///
/// This scans real source text on disk rather than reflecting over the compiled assembly: a
/// reflection-based check only sees types the bridge actually *uses*, so a forbidden reference
/// that gets optimized away, or one sitting in a method nobody calls yet, would pass silently. A
/// literal grep over "using MEditService.Core.Plugins"/"using MEditService.Core.Records" catches
/// the reference the moment someone types it, which is the whole point of the guard.
/// </summary>
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

    /// <summary>Exposed so the rival can be applied and removed without ever touching git state
    /// (root CLAUDE.md: restore rivals from a file copy, never `git checkout`/`git restore`) — the
    /// rival writes a throwaway file into the real Bridge source tree, runs this same scan, then
    /// deletes the file itself.</summary>
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
