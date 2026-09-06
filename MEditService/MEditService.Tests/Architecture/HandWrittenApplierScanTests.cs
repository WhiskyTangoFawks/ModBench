using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Architecture;

public sealed class HandWrittenApplierScanTests
{
    private static readonly string[] Needles =
    [
        "Activator.CreateInstance",
        "MajorRecordInstantiator.Activator(",
        ".SetValue(",
        ".Invoke(",
        "MakeGenericType",
    ];

    private static readonly string[] ScannedRoots =
        [Path.Combine("MEditService.Core", "Schema"), Path.Combine("MEditService.Core", "Edits")];

    private const string AllowlistPath = "MEditService.Tests/Architecture/hand-written-applier-allowlist.txt";

    // The name is captured dotted and matched on its last segment, so a fully qualified
    // construction cannot slip past; a name ending the line is an object initializer whose brace
    // opens on the next.
    private static readonly Regex Construction = new(@"\bnew\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:[(<{]|$)", RegexOptions.Compiled);

    private static readonly IReadOnlySet<string> MutagenTypeNames = MutagenAndNoggogTypeNames();

    [Fact]
    public void EditingStack_HandWritesNoApplier_OutsideTheAllowlist()
    {
        // The names come from the assemblies, so a load order that resolved none would pass this
        // over an empty set rather than over the surface it guards.
        Assert.Contains("MemorySlice", MutagenTypeNames);
        Assert.Contains("TranslatedString", MutagenTypeNames);
        Assert.Contains("FormLink", MutagenTypeNames);

        var root = ArchitectureTests.SolutionDirectory();

        AssertSitesMatchAllowlist(
            Sites(root, ScannedRoots),
            SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            AllowlistPath);
    }

    [Fact]
    public void TheScan_NamesASiteNoLineAllows_AndALineNoSiteMatches()
    {
        var root = Directory.CreateTempSubdirectory("medit-applier-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Layer", "obj"));
            File.WriteAllText(Path.Combine(root, "Layer", "Applier.cs"), "var made = new MemorySlice<byte>(bytes);");
            File.WriteAllText(Path.Combine(root, "Layer", "Generated.cs"), "var made = new MemorySlice<byte>(bytes);");
            File.Move(
                Path.Combine(root, "Layer", "Generated.cs"),
                Path.Combine(root, "Layer", "obj", "Generated.cs"));
            File.WriteAllText(Path.Combine(root, "Layer", "Clean.cs"), "var made = new JsonObject();");
            File.WriteAllText(Path.Combine(root, "Layer", "Initializer.cs"), "var made = new TranslatedString\n{\n    TargetLanguage = language,\n};");

            var sites = Sites(root, ["Layer"]);

            Assert.Equal(
                ["Layer/Applier.cs: var made = new MemorySlice<byte>(bytes);", "Layer/Initializer.cs: var made = new TranslatedString"],
                sites);

            var unallowedSite = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertSitesMatchAllowlist(sites, [], AllowlistPath));
            Assert.Contains("Layer/Applier.cs", unallowedSite.Message, StringComparison.Ordinal);

            var lineWithNoSite = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertSitesMatchAllowlist([], ["Layer/Gone.cs: var made = new MemorySlice<byte>(bytes);"], AllowlistPath));
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
        var unallowed = NotCoveredBy(sites, allowlist);
        var unmatched = NotCoveredBy(allowlist, sites);

        Assert.True(
            unallowed.Count == 0 && unmatched.Count == 0,
            $"The editing stack's hand-written applier sites differ from {allowlistPath}.\n"
            + $"Sites the allowlist does not name ({unallowed.Count}) — the codec owns deserialization, "
            + "so a site here needs the maintainer's ruling before its line is added:\n"
            + string.Join("\n", unallowed)
            + $"\nAllowlist lines matching no site ({unmatched.Count}) — delete them; the shrinking of this "
            + "list is what the work is measured by:\n"
            + string.Join("\n", unmatched));
    }

    private static List<string> Sites(string root, string[] scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r)).Order(StringComparer.Ordinal))
            .SelectMany(file => File.ReadLines(file)
                .Where(IsApplierSite)
                .Select(line => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {line.Trim()}"))
            .Order(StringComparer.Ordinal)];

    private static bool IsApplierSite(string line) =>
        Needles.Any(needle => line.Contains(needle, StringComparison.Ordinal))
        || Construction.Matches(line).Any(m => MutagenTypeNames.Contains(m.Groups[1].Value.Split('.')[^1]));

    // A site carries no line number: that would fail the gate for any unrelated edit above one.
    // Two sites can therefore be the same text in the same file.
    private static List<string> NotCoveredBy(IEnumerable<string> lines, IEnumerable<string> cover)
    {
        var available = cover.GroupBy(l => l, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        var uncovered = new List<string>();
        foreach (var line in lines)
        {
            if (available.TryGetValue(line, out var count) && count > 0) available[line] = count - 1;
            else uncovered.Add(line);
        }
        return uncovered;
    }

    private static IReadOnlySet<string> MutagenAndNoggogTypeNames()
    {
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        return AppDomain.CurrentDomain.GetAssemblies()
            .Where(a => a.GetName().Name is { } name
                && (name.StartsWith("Mutagen", StringComparison.Ordinal) || name.StartsWith("Noggog", StringComparison.Ordinal)))
            .SelectMany(a => a.GetExportedTypes())
            .Select(t => t.Name.Split('`')[0])
            .ToHashSet(StringComparer.Ordinal);
    }
}
