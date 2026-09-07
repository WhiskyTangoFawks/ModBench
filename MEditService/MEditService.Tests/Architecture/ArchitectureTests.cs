using System.Reflection;
using System.Text.RegularExpressions;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>Source-text and reflection checks for the invariants a compiling change can still break
/// silently. Each test names the ADR it enforces.</summary>
public sealed class ArchitectureTests
{
    private static readonly Assembly Core = typeof(ILoadOrderMirror).Assembly;

    // ADR-0036: a bare filename compiles and passes single-copy tests, then misidentifies.
    [Fact]
    public void PluginIdentity_TravelsAsNameAndOriginTogether_OnEverySeamMemberAndDto()
    {
        var offenders = new List<string>();
        foreach (var type in Core.GetExportedTypes().Where(t => t.IsInterface))
        {
            foreach (var method in type.GetMethods())
            {
                offenders.AddRange(PluginStringsWithoutOrigin(method.GetParameters())
                    .Select(p => $"{type.Name}.{method.Name}({p})"));
            }
            offenders.AddRange(PluginStringsWithoutOrigin(type.GetProperties().Select(p => (p.Name, p.PropertyType)).ToArray())
                .Select(p => $"{type.Name}.{p}"));
        }
        foreach (var record in Core.GetExportedTypes().Where(t => t.Namespace == "MEditService.Core.Queries" && t.GetMethod("<Clone>$") != null))
        {
            var primary = record.GetConstructors().MaxBy(c => c.GetParameters().Length)!;
            offenders.AddRange(PluginStringsWithoutOrigin(primary.GetParameters())
                .Select(p => $"{record.Name}({p})"));
        }
        Assert.True(offenders.Count == 0, "A plugin name travels without its origin:\n" + string.Join("\n", offenders));
    }

    // A typed PluginKey parameter already carries both halves; only a string name can travel alone.
    internal static IEnumerable<string> PluginStringsWithoutOrigin(ParameterInfo[] parameters) =>
        PluginStringsWithoutOrigin(parameters.Select(p => (p.Name!, p.ParameterType)).ToArray());

    internal static IEnumerable<string> PluginStringsWithoutOrigin((string Name, Type Type)[] members)
    {
        foreach (var (name, type) in members.Where(m => m.Type == typeof(string)))
        {
            var match = Regex.Match(name, "^(.*?)(plugin|pluginName)$", RegexOptions.IgnoreCase);
            if (!match.Success) continue;
            var origin = match.Groups[1].Value + "origin";
            if (!members.Any(m => m.Name.Equals(origin, StringComparison.OrdinalIgnoreCase))) yield return name;
        }
    }

    // ADR-0001: the index validates itself by content hash; an mtime shortcut passes the
    // persistence tests, which rewrite files, and then trusts a file another tool touched.
    [Fact]
    public void DiskDerivedState_NeverReadsLastWriteTime()
    {
        var offenders = Offenders(SolutionDirectory(), Projects, "LastWriteTime", allowedFiles: []);
        Assert.True(offenders.Count == 0, "mtime read in:\n" + string.Join("\n", offenders));
    }

    // ADR-0044: PUT /load-order is the only arrival; a second caller makes the mirror's Status lie,
    // and a second writer makes the shared kernel's load order disagree with the index.
    [Fact]
    public void LoadOrder_ArrivesOnlyThroughTheLoadOrderEndpoint()
    {
        // Scoped by the holder type rather than by a receiver name, so renaming the variable a write
        // goes through cannot disarm this.
        string[] writers = ["LoadOrderEndpoints.cs", "PluginEndpoints.cs", "LoadOrderHolder.cs"];
        var offenders = Offenders(SolutionDirectory(), Projects, [".Reconcile("], ["LoadOrderEndpoints.cs"])
            .Concat(Offenders(SolutionDirectory(), Projects, [nameof(LoadOrderHolder), ".Apply("], writers))
            .Concat(Offenders(SolutionDirectory(), Projects, [nameof(LoadOrderHolder), ".Register("], writers))
            .Distinct()
            .ToList();
        Assert.True(offenders.Count == 0,
            "The load order is reconciled or written outside its endpoints in:\n" + string.Join("\n", offenders));
    }

    // ADR-0008: PluginWriter backs the binary up first; LoadOrderMirror writes only a brand-new
    // file and TrackService only a scratch copy, so neither has anything to back up.
    [Fact]
    public void ExistingPluginBinary_IsWrittenOnlyByPluginWriter()
    {
        string[] allowed = ["PluginWriter.cs", "LoadOrderMirror.cs", "TrackService.cs"];
        var offenders = Offenders(SolutionDirectory(), Projects, "WriteToBinary(", allowed)
            .Concat(Offenders(SolutionDirectory(), Projects, "BeginWrite", allowed))
            .ToList();
        Assert.True(offenders.Count == 0, "Plugin binary written outside PluginWriter in:\n" + string.Join("\n", offenders));
    }

    // The repo is public: a plugin lands in TestData only by a deliberate edit to the allowlist.
    [Fact]
    public void TestDataPlugins_AreExactlyTheAllowlist()
    {
        var testData = Path.Combine(SolutionDirectory(), "MEditService.Tests", "TestData");
        var allowed = SourceTree.ReadAllowlist(Path.Combine(testData, "allowed-plugins.txt"))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var present = Directory.EnumerateFiles(testData, "*.es?").Select(Path.GetFileName).Select(n => n!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        Assert.Equal(allowed.Order(), present.Order());
    }

    private static readonly string[] Projects = ["MEditService.Core", "MEditService.Api"];

    internal static List<string> Offenders(string root, string[] projects, string needle, string[] allowedFiles) =>
        Offenders(root, projects, [needle], allowedFiles);

    // Every needle, not any: a conjunction scopes a common token like ".Apply(" to the files that
    // name the type it is forbidden on.
    internal static List<string> Offenders(string root, string[] projects, string[] needles, string[] allowedFiles)
    {
        return projects
            .SelectMany(p => SourceTree.CSharpFiles(Path.Combine(root, p)))
            .Where(f => !allowedFiles.Contains(Path.GetFileName(f)))
            .Where(f => File.ReadAllText(f) is var text
                && needles.All(n => text.Contains(n, StringComparison.Ordinal)))
            .Select(f => Path.GetRelativePath(root, f))
            .ToList();
    }

    [Fact]
    public void Offenders_NamesTheFileCarryingTheNeedle_AndSkipsAllowedFilesAndBuildOutput()
    {
        var root = Directory.CreateTempSubdirectory("medit-arch-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "P", "obj"));
            File.WriteAllText(Path.Combine(root, "P", "Bad.cs"), "var t = info.LastWriteTime;");
            File.WriteAllText(Path.Combine(root, "P", "Allowed.cs"), "var t = info.LastWriteTime;");
            File.WriteAllText(Path.Combine(root, "P", "obj", "Generated.cs"), "var t = info.LastWriteTime;");
            File.WriteAllText(Path.Combine(root, "P", "Clean.cs"), "var t = 1;");

            var offenders = Offenders(root, ["P"], "LastWriteTime", allowedFiles: ["Allowed.cs"]);

            Assert.Equal([Path.Combine("P", "Bad.cs")], offenders);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Offenders_NamesOnlyTheFileCarryingEveryNeedle()
    {
        var root = Directory.CreateTempSubdirectory("medit-arch-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "P"));
            File.WriteAllText(Path.Combine(root, "P", "Both.cs"), "var h = new Holder(); renamed.Apply(x);");
            File.WriteAllText(Path.Combine(root, "P", "OnlyType.cs"), "var h = new Holder();");
            File.WriteAllText(Path.Combine(root, "P", "OnlyCall.cs"), "renamed.Apply(x);");

            var offenders = Offenders(root, ["P"], ["Holder", ".Apply("], allowedFiles: []);

            Assert.Equal([Path.Combine("P", "Both.cs")], offenders);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void PluginStringsWithoutOrigin_FlagsABareName_AndAcceptsAPairOrATypedKey()
    {
        static void Bare(string plugin, string other) { }
        static void Paired(string sourcePlugin, string sourceOrigin, string destinationPlugin) { }
        static void Typed(PluginKey plugin) { }

        Assert.Equal(["plugin"], PluginStringsWithoutOrigin(ParametersOf(Bare)));
        Assert.Equal(["destinationPlugin"], PluginStringsWithoutOrigin(ParametersOf(Paired)));
        Assert.Empty(PluginStringsWithoutOrigin(ParametersOf(Typed)));
        Assert.Equal(["Plugin"], PluginStringsWithoutOrigin([("Plugin", typeof(string)), ("Path", typeof(string))]));
    }

    private static ParameterInfo[] ParametersOf(Delegate method) => method.Method.GetParameters();

    internal static string SolutionDirectory()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "MEditService.sln")))
            dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("MEditService.sln not found above the test output directory.");
    }
}
