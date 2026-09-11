using System.Reflection;
using System.Text.RegularExpressions;
using MEditService.Api;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>Source-text and reflection checks for the invariants a compiling change can still break
/// silently. Each test names the ADR it enforces.</summary>
public sealed class ArchitectureTests
{
    private static readonly Assembly Core = typeof(IndexProjector).Assembly;

    // Where a DTO's own shape decides identity: the read side's models, and the wire records the
    // endpoints bind. A record in either travels to the frontend as it is declared.
    private static readonly (Assembly Assembly, string Namespace)[] DtoBoxes =
    [
        (Core, "MEditService.Core.Queries"),
        (typeof(RecordEditRequest).Assembly, "MEditService.Api"),
    ];

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
        foreach (var record in DtoBoxes.SelectMany(box => box.Assembly.GetExportedTypes()
            .Where(t => t.Namespace == box.Namespace && t.GetMethod("<Clone>$") != null)))
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

    // Zero offenders and zero files walked read the same: a Projects typo that scans nothing
    // would still pass the assertion above.
    [Fact]
    public void DiskDerivedState_TheScanWalksMoreThanOneHundredFiles()
    {
        var root = SolutionDirectory();
        var walked = Projects.SelectMany(p => SourceTree.CSharpFiles(Path.Combine(root, p))).Count();
        Assert.True(walked > 100, $"The mtime scan walked only {walked} files under {string.Join(", ", Projects)}.");
    }

    // The same Offenders() the assertion above calls, with its own needle: proves a planted mtime
    // read is caught rather than the needle itself having gone stale.
    [Fact]
    public void DiskDerivedState_TheScanCatchesAPlantedLastWriteTimeRead()
    {
        var root = Directory.CreateTempSubdirectory("medit-mtime-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "P"));
            File.WriteAllText(Path.Combine(root, "P", "Planted.cs"), "var t = info.LastWriteTime;");

            var offenders = Offenders(root, ["P"], "LastWriteTime", allowedFiles: []);

            Assert.Equal([Path.Combine("P", "Planted.cs")], offenders);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // ADR-0044: PUT /load-order is the only arrival; a second caller makes the Index's Status lie,
    // and a second writer makes the shared kernel's load order disagree with the index.
    [Fact]
    public void LoadOrder_ArrivesOnlyThroughTheLoadOrderEndpoint()
    {
        var root = SolutionDirectory();
        // The reconcile request is the endpoint's alone. ADR-0041's created copy is registered on the
        // kernel and reaches the Index through the next snapshot, so the create gesture is a writer
        // and never a reconciler.
        string[] reconcilers = ["LoadOrderEndpoints.cs"];
        // Scoped by the holder type rather than by a receiver name, so renaming the variable a write
        // goes through cannot disarm this.
        string[] writers = ["LoadOrderEndpoints.cs", "CreatePluginHandler.cs"];

        var reconciles = Offenders(root, Projects, [".Reconcile("], []);
        var applies = Offenders(root, Projects, [nameof(LoadOrderHolder), ".Apply("], []);
        var registers = Offenders(root, Projects, [nameof(LoadOrderHolder), ".Register("], []);

        var offenders = Unallowed(reconciles, reconcilers)
            .Concat(Unallowed(applies, writers))
            .Concat(Unallowed(registers, writers))
            .Distinct()
            .ToList();
        Assert.True(offenders.Count == 0,
            "The load order is reconciled or written outside its endpoints in:\n" + string.Join("\n", offenders));

        var dead = DeadAllowances(reconcilers, reconciles).Concat(DeadAllowances(writers, applies, registers)).ToList();
        Assert.True(dead.Count == 0,
            "Allowances naming no such call — delete them rather than leaving a write pre-authorized:\n"
            + string.Join("\n", dead));
    }

    private static readonly string LoadOrderFolder = Path.Combine("MEditService.Core", "Plugins");

    // ADR-0046 invariant 11: the load order value is built from what Mod Management sent. An
    // adapter type here is a disk read on its construction path.
    [Fact]
    public void TheLoadOrderValue_NamesNoPluginAdapterType()
    {
        var offenders = Offenders(
            SolutionDirectory(), [LoadOrderFolder], "MEditService.Core.PluginAdapter", allowedFiles: []);

        Assert.True(offenders.Count == 0,
            "The load order folder reaches into the Plugin adapter in:\n" + string.Join("\n", offenders));
    }

    // The value is what Mod Management sent, so a disk read here answers from the instance rather
    // than from the snapshot — and the two disagree the moment another tool touches a file.
    [Fact]
    public void TheLoadOrderValue_ReadsNoFileOrDirectory()
    {
        var offenders = Offenders(SolutionDirectory(), [LoadOrderFolder], "File.", allowedFiles: [])
            .Concat(Offenders(SolutionDirectory(), [LoadOrderFolder], "Directory.", allowedFiles: []))
            .Distinct()
            .ToList();

        Assert.True(offenders.Count == 0,
            "The load order folder reads the disk in:\n" + string.Join("\n", offenders));
    }

    // Zero offenders and an empty folder read the same: a path that scanned nothing would still
    // pass the assertions above.
    [Fact]
    public void TheLoadOrderValueScan_WalksTheLoadOrderFolder()
    {
        var walked = SourceTree.CSharpFiles(Path.Combine(SolutionDirectory(), LoadOrderFolder))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Contains("LoadOrder.cs", walked);
        Assert.Contains("Registration.cs", walked);
    }

    private static IEnumerable<string> Unallowed(List<string> named, string[] allowed) =>
        named.Where(f => !allowed.Contains(Path.GetFileName(f)));

    // An allowance matching no call pre-authorizes a write nobody reviews, and reads as though the
    // rule had an exception it does not have.
    internal static List<string> DeadAllowances(string[] allowed, params List<string>[] scans)
    {
        var named = scans.SelectMany(s => s).Select(Path.GetFileName).ToHashSet(StringComparer.Ordinal);
        return [.. allowed.Where(a => !named.Contains(a)).Order(StringComparer.Ordinal)];
    }

    [Fact]
    public void DeadAllowances_NamesAnAllowanceNoScanMatched_AndKeepsOneAnyScanDid()
    {
        Assert.Equal(
            ["Stale.cs"],
            DeadAllowances(["Applies.cs", "Registers.cs", "Stale.cs"], ["P/Applies.cs"], ["P/Registers.cs"]));
    }

    // ADR-0046 invariant 3: Queries are the Index's only readers, so a member no query service
    // calls is a widening nobody asked for — and every implementer, the projector and each query
    // test's stub alike, pays for it.
    [Fact]
    public void TheIndexReadInterface_HoldsOnlyMembersTheQueryServicesCall()
    {
        var queries = SourceTree
            .CSharpFiles(Path.Combine(SolutionDirectory(), "MEditService.Core", "Queries"))
            .Select(File.ReadAllText)
            .ToList();
        // Property getters travel as get_X methods; naming the property is what a caller does.
        var members = typeof(IQueryIndex).GetProperties().Select(m => m.Name)
            .Concat(typeof(IQueryIndex).GetMethods().Where(m => !m.IsSpecialName).Select(m => m.Name));
        var uncalled = members
            .Where(name => !queries.Exists(text => text.Contains($".{name}", StringComparison.Ordinal)))
            .ToList();
        Assert.True(uncalled.Count == 0,
            $"{nameof(IQueryIndex)} carries members no query service calls:\n" + string.Join("\n", uncalled));
    }

    // ADR-0046 invariant 11: one load order, the kernel's value, read from the holder. A query that
    // reaches the Index's view of it instead can disagree with a command mid-reconcile.
    [Fact]
    public void TheQueryServices_AndTheIndexReadInterface_NameNoLoadOrderInterface()
    {
        var readSide = Path.Combine(SolutionDirectory(), "MEditService.Core", "Records");
        var offenders = SourceTree
            .CSharpFiles(Path.Combine(SolutionDirectory(), "MEditService.Core", "Queries"))
            .Append(Path.Combine(readSide, "IQueryIndex.cs"))
            .Append(Path.Combine(readSide, "IRecordReads.cs"))
            .Where(file => File.ReadAllText(file).Contains(nameof(ILoadOrder), StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(offenders.Count == 0,
            $"The read side still names {nameof(ILoadOrder)}:\n" + string.Join("\n", offenders));
    }

    // ADR-0044: participation is derived — enabled, winning, and named by a plugins.txt line — and
    // the load order value is the one place that rule is spelled. A second spelling is how two
    // answers start disagreeing.
    [Fact]
    public void TheParticipationRule_IsSpelledOnceInProduction()
    {
        var root = SolutionDirectory();
        var spellings = Projects
            .SelectMany(p => SourceTree.CSharpFiles(Path.Combine(root, p)))
            .Where(file => ParticipationRule.IsMatch(File.ReadAllText(file)))
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.Equal(["MEditService.Core/Plugins/Registration.cs"], spellings);
    }

    // The three facts joined, in C# or in SQL: `Enabled && Winning &&` and `x.enabled AND x.winning
    // AND` both match, and either one alone does not — a read of a single fact is ordinary.
    private static readonly Regex ParticipationRule = new(
        @"enabled\s*(?:&&|AND)\s*[^\n]{0,24}?winning\s*(?:&&|AND)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(5));

    [Fact]
    public void TheParticipationRulePattern_MatchesBothSpellings_AndNotASingleFact()
    {
        Assert.Matches(ParticipationRule, "Enabled && Winning && LoadOrderIndex is not null");
        Assert.Matches(ParticipationRule, "$\"{alias}.enabled AND {alias}.winning AND {alias}.load_order_idx IS NOT NULL\"");
        Assert.DoesNotMatch(ParticipationRule, "reader.GetBoolean(3) is var enabled && winning is null");
        Assert.DoesNotMatch(ParticipationRule, "registration.Enabled && registration.LoadOrderIndex is not null");
    }

    private static readonly string[] PluginBinaryWriters = ["MutagenPluginAdapter.cs"];

    // The codec asks the factory for the release's mod type; nothing else opens or mints a mod.
    private static readonly string[] ModFactoryCallers = ["MutagenPluginAdapter.cs", "RecordTypeDispatch.cs"];

    // ADR-0032 rule 2: bytes become a mod, and a mod becomes bytes, in the adapter alone — which is
    // where ADR-0008's backup-first discipline then sits.
    [Fact]
    public void APluginBinary_IsOpenedAndWrittenOnlyByThePluginAdapter()
    {
        var offenders = Offenders(SolutionDirectory(), Projects, "WriteToBinary(", PluginBinaryWriters)
            .Concat(Offenders(SolutionDirectory(), Projects, "BeginWrite", PluginBinaryWriters))
            .Concat(Offenders(SolutionDirectory(), Projects, "ModFactory.", ModFactoryCallers))
            .Concat(Offenders(SolutionDirectory(), Projects, "CreateFromBinary", ModFactoryCallers))
            .ToList();
        Assert.True(offenders.Count == 0,
            "A plugin binary is opened or written outside the Plugin adapter in:\n" + string.Join("\n", offenders));
    }

    // Zero offenders and zero files walked read the same: a Projects typo that scans nothing
    // would still pass the assertion above.
    [Fact]
    public void ExistingPluginBinary_TheScanWalksMoreThanOneHundredFiles()
    {
        var root = SolutionDirectory();
        var walked = Projects.SelectMany(p => SourceTree.CSharpFiles(Path.Combine(root, p))).Count();
        Assert.True(walked > 100, $"The plugin-binary-write scan walked only {walked} files under {string.Join(", ", Projects)}.");
    }

    // The same Offenders() the assertion above calls, with its own four needles: proves a planted
    // open or write outside the adapter is caught under every spelling.
    [Fact]
    public void ExistingPluginBinary_TheScanCatchesAPlantedBinaryOpenOrWriteOutsideAnAllowedFile()
    {
        var root = Directory.CreateTempSubdirectory("medit-plugin-binary-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "P"));
            File.WriteAllText(Path.Combine(root, "P", "WriteToBinary.cs"), "plugin.WriteToBinary(path);");
            File.WriteAllText(Path.Combine(root, "P", "BeginWrite.cs"), "recompiled.BeginWrite.ToPath(path);");
            File.WriteAllText(Path.Combine(root, "P", "Import.cs"), "var mod = ModFactory.ImportSetter(path, release);");
            File.WriteAllText(Path.Combine(root, "P", "Reload.cs"), "var mod = Fallout4Mod.CreateFromBinary(path, release);");
            File.WriteAllText(Path.Combine(root, "P", "MutagenPluginAdapter.cs"), "plugin.WriteToBinary(ModFactory.X);");

            var offenders = Offenders(root, ["P"], "WriteToBinary(", PluginBinaryWriters)
                .Concat(Offenders(root, ["P"], "BeginWrite", PluginBinaryWriters))
                .Concat(Offenders(root, ["P"], "ModFactory.", ModFactoryCallers))
                .Concat(Offenders(root, ["P"], "CreateFromBinary", ModFactoryCallers))
                .ToList();

            Assert.Equal(
                [Path.Combine("P", "BeginWrite.cs"), Path.Combine("P", "Import.cs"),
                 Path.Combine("P", "Reload.cs"), Path.Combine("P", "WriteToBinary.cs")],
                offenders.Order(StringComparer.Ordinal));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // ADR-0008: the adapter's write verb lays bytes down with neither backup nor rename, so who
    // calls it is the whole of the backup discipline.
    [Fact]
    public void ThePluginAdapterWriteVerb_IsCalledOnlyByThePluginWriterAndTheGesturesWithNothingToBackUp()
    {
        // PluginWriter backs the existing binary up first, PluginTrees writes a scratch copy, and
        // the create gesture writes a brand-new file — none has an existing binary to back up.
        string[] writers = ["PluginWriter.cs", "PluginTrees.cs", "CreatePluginHandler.cs"];

        // Carries no leading dot, so CreateAndWriteAsync is caught alongside WriteAsync; the two
        // adapter files that declare and implement them call neither.
        var writes = Offenders(
            SolutionDirectory(), Projects, ["PluginAdapter", "WriteAsync("],
            [.. PluginBinaryWriters, "IPluginAdapter.cs"]);

        var offenders = Unallowed(writes, writers).ToList();
        Assert.True(offenders.Count == 0,
            "ADR-0008: a plugin binary is backed up before it is written, and the adapter's write verb makes "
            + "no backup. Only PluginWriter (which backs up first), PluginTrees (which writes a scratch "
            + "copy) and the create gesture (which writes a file with no existing binary) may call it. It "
            + "is called in:\n" + string.Join("\n", offenders));

        var dead = DeadAllowances(writers, writes).ToList();
        Assert.True(dead.Count == 0,
            "Allowances naming no such call — delete them rather than leaving a plugin write pre-authorized:\n"
            + string.Join("\n", dead));
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

    private static readonly string[] Projects = ["MEditService.Core", "MEditService.Api", "MEditService.Bridge"];

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
