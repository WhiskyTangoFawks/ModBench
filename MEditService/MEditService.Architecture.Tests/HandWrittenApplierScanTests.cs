using System.Text.RegularExpressions;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Architecture.Tests;

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
        [Path.Combine("MEditService.Codec", "Schema"), Path.Combine("MEditService.Commands", "Edits")];

    private static readonly Regex QualifiedOrLineEndingConstruction = new(@"\bnew\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:[(<{]|$)", RegexOptions.Compiled);

    private static readonly IReadOnlySet<string> MutagenTypeNames = MutagenAndNoggogTypeNames();

    [Fact]
    public void EditingStack_HandWritesNoApplier()
    {
        Assert.Contains("MemorySlice", MutagenTypeNames);
        Assert.Contains("TranslatedString", MutagenTypeNames);
        Assert.Contains("FormLink", MutagenTypeNames);

        var sites = Sites(ServiceProjects.SolutionDirectory(), ScannedRoots);

        Assert.True(
            sites.Count == 0,
            "The editing stack's hand-written applier sites — the codec owns deserialization:\n"
            + string.Join("\n", sites));
    }

    [Fact]
    public void TheScan_NamesAMutagenConstruction_AndPassesBuildOutputAndOtherTypes()
    {
        using var root = new ScratchDirectory("medit-applier-scan-");
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
    }

    private static List<string> Sites(string root, IReadOnlyList<string> scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r)).Order(StringComparer.Ordinal))
            .SelectMany(file => File.ReadLines(file)
                .Where(IsApplierSite)
                .Select(line => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {line.Trim()}"))
            .Order(StringComparer.Ordinal)];

    private static bool IsApplierSite(string line) =>
        Needles.Any(needle => line.Contains(needle, StringComparison.Ordinal))
        || QualifiedOrLineEndingConstruction.Matches(line).Any(m => MutagenTypeNames.Contains(m.Groups[1].Value.Split('.')[^1]));

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
