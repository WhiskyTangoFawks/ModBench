using System.Text.RegularExpressions;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Architecture.Tests;

public sealed class GameNamespaceScanTests
{
    private static readonly string[] GameNames = [.. Enum.GetNames<GameCategory>().Order(StringComparer.Ordinal)];

    private static readonly string[] GameNamespaces = [.. GameNames.Select(game => $"Mutagen.Bethesda.{game}")];

    private static readonly IReadOnlyList<string> ScannedRoots =
        ServiceProjects.Production(ServiceProjects.SolutionDirectory());

    private static readonly string[] ExemptFolders =
    [
        "MEditService.Codec.Fallout4",
        "MEditService.Codec.Skyrim",
        "MEditService.Codec.Starfield",
    ];

    private static readonly Regex Identifier = new(@"\b[A-Za-z_][A-Za-z0-9_]*\b", RegexOptions.Compiled);

    private static readonly IReadOnlySet<string> GameTypeNames = GameConcreteTypeNames();

    [Fact]
    public void TheStackOutsideTheCodecGameProjects_NamesNoGameNamespace()
    {
        Assert.Contains("Fallout4", GameNames);
        Assert.Contains("Fallout4Mod", GameTypeNames);
        Assert.Contains("IFallout4ModGetter", GameTypeNames);
        Assert.Contains("ISkyrimModGetter", GameTypeNames);

        var sites = Sites(ServiceProjects.SolutionDirectory(), ScannedRoots, ExemptFolders);

        Assert.True(
            sites.Count == 0,
            "Game-concrete Mutagen names outside the codec's game projects — a record is a Mutagen "
            + "object only while it is being read from bytes or written to them, so ask the codec "
            + "instead of naming a game here:\n"
            + string.Join("\n", sites));
    }

    [Fact]
    public void TheScan_PassesTheExemptFolders_AndNamesAGameNamespaceOrTypeElsewhere()
    {
        using var root = new ScratchDirectory("medit-game-namespace-scan-");
        ScratchFiles.Plant(root, "Codec/Codec.cs",
            "using Mutagen.Bethesda.Fallout4;\nvar mod = new Fallout4Mod(key, release);");
        ScratchFiles.Plant(root, "Layer/Rival.cs", "using Mutagen.Bethesda.Fallout4;");
        ScratchFiles.Plant(root, "Layer/Unqualified.cs", "IFallout4ModGetter mod = Open(path);");
        ScratchFiles.Plant(root, "Layer/Clean.cs", "var release = GameRelease.Fallout4; // Fallout4.esm");

        var sites = Sites(root, ["Codec", "Layer"], ["Codec"]);

        Assert.Equal(
            ["Layer/Rival.cs: using Mutagen.Bethesda.Fallout4;", "Layer/Unqualified.cs: IFallout4ModGetter mod = Open(path);"],
            sites);
    }

    private static List<string> Sites(string root, IReadOnlyList<string> scannedRoots, string[] exemptFolders) =>
        [.. scannedRoots
            .SelectMany(scanned => SourceTree.CSharpFiles(Path.Combine(root, scanned)))
            .Select(file => (File: file, Relative: Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')))
            .Where(f => !exemptFolders.Any(folder => f.Relative.StartsWith(folder + "/", StringComparison.Ordinal)))
            .SelectMany(f => File.ReadLines(f.File)
                .Where(IsGameSite)
                .Select(line => $"{f.Relative}: {line.Trim()}"))
            .Order(StringComparer.Ordinal)];

    private static bool IsGameSite(string line) =>
        GameNamespaces.Any(ns => line.Contains(ns, StringComparison.Ordinal))
        || Identifier.Matches(line).Any(m => GameTypeNames.Contains(m.Value));

    private static IReadOnlySet<string> GameConcreteTypeNames()
    {
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE);
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
