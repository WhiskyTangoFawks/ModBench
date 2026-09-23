using System.Text.RegularExpressions;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Architecture;

/// <summary>ADR-0005 rule 2: the game-concrete namespaces are the codec's and the Plugin adapter's
/// alone. The banned-API analyzer holds the live-object namespaces; this scan holds the per-game
/// ones.</summary>
public sealed class GameNamespaceScanTests
{
    // Read off the pinned assembly, so a game Mutagen adds is scanned for without an edit here.
    private static readonly string[] GameNames = [.. Enum.GetNames<GameCategory>().Order(StringComparer.Ordinal)];

    private static readonly string[] GameNamespaces = [.. GameNames.Select(game => $"Mutagen.Bethesda.{game}")];

    private static readonly string[] ScannedRoots =
    ["MEditService.Codec", "MEditService.Commands", "MEditService.Http", "MEditService.Index",
         "MEditService.LoadOrder", "MEditService.PluginAdapter", "MEditService.Ports",
         "MEditService.Queries", "MEditService.SourceAdapter", "MEditService.Watcher"];

    // The codec and the Plugin adapter, the two boxes the game assemblies live in.
    private static readonly string[] ExemptFolders =
    [
        "MEditService.Codec/Serialization",
        "MEditService.Codec/Schema",
        "MEditService.PluginAdapter",
    ];

    private const string AllowlistPath = "MEditService.Http.Tests/Architecture/game-namespace-allowlist.txt";

    private static readonly Regex Identifier = new(@"\b[A-Za-z_][A-Za-z0-9_]*\b", RegexOptions.Compiled);

    private static readonly IReadOnlySet<string> GameTypeNames = GameConcreteTypeNames();

    [Fact]
    public void TheStackOutsideTheCodecAndTheAdapter_NamesAGameNamespace_OnlyWhereTheAllowlistSays()
    {
        // The names come from the assemblies, so a load order that resolved none would pass this
        // over an empty set rather than over the surface it guards.
        Assert.Contains("Fallout4", GameNames);
        Assert.Contains("Fallout4Mod", GameTypeNames);
        Assert.Contains("IFallout4ModGetter", GameTypeNames);

        var root = ArchitectureTests.SolutionDirectory();

        AssertSitesMatchAllowlist(
            Sites(root, ScannedRoots, ExemptFolders),
            SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            AllowlistPath);
    }

    [Fact]
    public void TheScan_PassesTheExemptFolders_AndNamesASiteNoLineAllows_AndALineNoSiteMatches()
    {
        var root = Directory.CreateTempSubdirectory("medit-game-namespace-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Codec"));
            Directory.CreateDirectory(Path.Combine(root, "Layer", "obj"));
            File.WriteAllText(
                Path.Combine(root, "Codec", "Codec.cs"),
                "using Mutagen.Bethesda.Fallout4;\nvar mod = new Fallout4Mod(key, release);");
            File.WriteAllText(Path.Combine(root, "Layer", "obj", "Generated.cs"), "using Mutagen.Bethesda.Fallout4;");
            File.WriteAllText(Path.Combine(root, "Layer", "Rival.cs"), "using Mutagen.Bethesda.Fallout4;");
            File.WriteAllText(Path.Combine(root, "Layer", "Unqualified.cs"), "IFallout4ModGetter mod = Open(path);");
            // GameRelease is identity, not a game-concrete type, and stays legible everywhere.
            File.WriteAllText(Path.Combine(root, "Layer", "Clean.cs"), "var release = GameRelease.Fallout4; // Fallout4.esm");

            var sites = Sites(root, ["Codec", "Layer"], ["Codec"]);

            Assert.Equal(
                ["Layer/Rival.cs: using Mutagen.Bethesda.Fallout4;", "Layer/Unqualified.cs: IFallout4ModGetter mod = Open(path);"],
                sites);

            var unallowedSite = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertSitesMatchAllowlist(sites, [], AllowlistPath));
            Assert.Contains("Layer/Rival.cs", unallowedSite.Message, StringComparison.Ordinal);
            Assert.Contains("Layer/Unqualified.cs", unallowedSite.Message, StringComparison.Ordinal);

            var lineWithNoSite = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertSitesMatchAllowlist(sites, [.. sites, "Layer/Gone.cs: using Mutagen.Bethesda.Fallout4;"], AllowlistPath));
            Assert.Contains("Layer/Gone.cs", lineWithNoSite.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void AssertSitesMatchAllowlist(
        IReadOnlyList<string> sites, IReadOnlyList<string> allowlist, string allowlistPath)
    {
        var unallowed = SourceTree.NotCoveredBy(sites, allowlist);
        var unmatched = SourceTree.NotCoveredBy(allowlist, sites);

        Assert.True(
            unallowed.Count == 0 && unmatched.Count == 0,
            $"Game-concrete Mutagen names outside the codec and the Plugin adapter differ from {allowlistPath}.\n"
            + $"Sites the allowlist does not name ({unallowed.Count}) — a record is a Mutagen object only while "
            + "it is being read from bytes or written to them, so ask the codec or the adapter instead of naming "
            + "a game here:\n"
            + string.Join("\n", unallowed)
            + $"\nAllowlist lines matching no site ({unmatched.Count}) — delete them; the shrinking of this list "
            + "is what the work is measured by:\n"
            + string.Join("\n", unmatched));
    }

    // A site carries no line number: that would fail the gate for any unrelated edit above one.
    private static List<string> Sites(string root, string[] scannedRoots, string[] exemptFolders) =>
        [.. scannedRoots
            .SelectMany(scanned => SourceTree.CSharpFiles(Path.Combine(root, scanned)))
            .Select(file => (File: file, Relative: Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')))
            .Where(f => !exemptFolders.Any(folder => f.Relative.StartsWith(folder + "/", StringComparison.Ordinal)))
            .SelectMany(f => File.ReadLines(f.File)
                .Where(IsGameSite)
                .Select(line => $"{f.Relative}: {line.Trim()}"))
            .Order(StringComparer.Ordinal)];

    // A game-concrete type whose own name names no game — Weapon, Npc — reaches no file without a
    // qualified name or a using, so the namespace needle names that file anyway.
    private static bool IsGameSite(string line) =>
        GameNamespaces.Any(ns => line.Contains(ns, StringComparison.Ordinal))
        || Identifier.Matches(line).Any(m => GameTypeNames.Contains(m.Value));

    private static IReadOnlySet<string> GameConcreteTypeNames()
    {
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        return AppDomain.CurrentDomain.GetAssemblies()
            .Where(a => GameNamespaces.Contains(a.GetName().Name, StringComparer.Ordinal))
            .SelectMany(a => a.GetExportedTypes())
            .Where(t => t.Namespace is { } ns && GameNamespaces.Any(
                game => ns == game || ns.StartsWith(game + ".", StringComparison.Ordinal)))
            .Select(t => t.Name.Split('`')[0])
            .Where(name => GameNames.Any(game => name.Contains(game, StringComparison.Ordinal)))
            .ToHashSet(StringComparer.Ordinal);
    }
}
