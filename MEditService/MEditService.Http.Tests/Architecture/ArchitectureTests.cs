using System.Reflection;
using System.Text.RegularExpressions;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.Queries;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class ArchitectureTests
{
    private static readonly Assembly[] EveryBoxAssembly =
    [
        typeof(RecordTextCodec).Assembly,
        typeof(TrackHandler).Assembly,
        typeof(RecordEditRequest).Assembly,
        typeof(Indexer).Assembly,
        typeof(LoadOrderSnapshot).Assembly,
        typeof(IPluginAdapter).Assembly,
        typeof(INotificationPublisher).Assembly,
        typeof(IRecordQueryService).Assembly,
        typeof(SourceRepository).Assembly,
    ];

    private static readonly (Assembly Assembly, string Namespace)[] ReadModelAndWireRecordNamespaces =
    [
        (typeof(IRecordQueryService).Assembly, "MEditService.Queries"),
        (typeof(RecordEditRequest).Assembly, "MEditService.Http"),
    ];

    [Fact]
    public void PluginIdentity_TravelsAsNameAndOriginTogether_OnEverySeamMemberAndDto()
    {
        var offenders = new List<string>();
        foreach (var type in EveryBoxAssembly.SelectMany(box => box.GetExportedTypes()).Where(t => t.IsInterface))
        {
            foreach (var method in type.GetMethods())
            {
                offenders.AddRange(PluginStringsWithoutOrigin(method.GetParameters())
                    .Select(p => $"{type.Name}.{method.Name}({p})"));
            }
            offenders.AddRange(PluginStringsWithoutOrigin(type.GetProperties().Select(p => (p.Name, p.PropertyType)).ToArray())
                .Select(p => $"{type.Name}.{p}"));
        }
        foreach (var record in ReadModelAndWireRecordNamespaces.SelectMany(box => box.Assembly.GetExportedTypes()
            .Where(t => t.Namespace == box.Namespace && t.GetMethod("<Clone>$") != null)))
        {
            var primary = record.GetConstructors().MaxBy(c => c.GetParameters().Length)
                ?? throw new InvalidOperationException($"Expected '{record.Name}' to declare a constructor.");
            offenders.AddRange(PluginStringsWithoutOrigin(primary.GetParameters())
                .Select(p => $"{record.Name}({p})"));
        }
        Assert.True(offenders.Count == 0, "A plugin name travels without its origin:\n" + string.Join("\n", offenders));
    }

    internal static IEnumerable<string> PluginStringsWithoutOrigin(ParameterInfo[] parameters) =>
        PluginStringsWithoutOrigin(parameters
            .Select(p => (p.Name ?? throw new InvalidOperationException("Expected a parameter to have a name."), p.ParameterType))
            .ToArray());

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

    [Fact]
    public void DiskDerivedState_NeverReadsModificationTimeAlone()
    {
        var offenders = Offenders(SolutionDirectory(), Projects, "LastWriteTime", allowedFiles: []);
        Assert.True(offenders.Count == 0,
            "Modification time read without change time in:\n" + string.Join("\n", offenders));
    }

    [Fact]
    public void DiskDerivedState_TheScanWalksMoreThanOneHundredFiles()
    {
        var root = SolutionDirectory();
        var walked = Projects.SelectMany(p => SourceTree.CSharpFiles(Path.Combine(root, p))).Count();
        Assert.True(walked > 100, $"The mtime scan walked only {walked} files under {string.Join(", ", Projects)}.");
    }

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

    [Fact]
    public void LoadOrder_IsWrittenOnlyByPutLoadOrder_AndReconciledOnlyByTheIndex()
    {
        var root = SolutionDirectory();
        string[] reconcilers = [];
        string[] writers = ["PutLoadOrderHandler.cs"];

        var reconciles = Offenders(root, Projects, [".Reconcile("], []);
        var applies = HolderWrites(root, Projects, "Apply");

        var offenders = Unallowed(reconciles, reconcilers)
            .Concat(Unallowed(applies, writers))
            .Distinct()
            .ToList();
        Assert.True(offenders.Count == 0,
            "The load order is reconciled outside Load order state's own Changed subscriber, or "
            + "written outside PutLoadOrderHandler.cs, in:\n" + string.Join("\n", offenders));

        var dead = DeadAllowances(reconcilers, reconciles).Concat(DeadAllowances(writers, applies)).ToList();
        Assert.True(dead.Count == 0,
            "Allowances naming no such call — delete them rather than leaving a write pre-authorized:\n"
            + string.Join("\n", dead));
    }

    private const string LoadOrderFolder = "MEditService.LoadOrder";

    [Fact]
    public void TheLoadOrderValue_NamesNoPluginAdapterType()
    {
        var offenders = Offenders(
            SolutionDirectory(), [LoadOrderFolder], "MEditService.PluginAdapter", allowedFiles: []);

        Assert.True(offenders.Count == 0,
            "The load order folder reaches into the Plugin adapter in:\n" + string.Join("\n", offenders));
    }

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

    [Fact]
    public void TheLoadOrderValueScan_WalksTheLoadOrderFolder()
    {
        var walked = SourceTree.CSharpFiles(Path.Combine(SolutionDirectory(), LoadOrderFolder))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Contains("LoadOrderSnapshot.cs", walked);
        Assert.Contains("Registration.cs", walked);
    }

    internal static List<string> HolderWrites(string root, string[] projects, string verb) =>
        [.. projects
            .SelectMany(p => SourceTree.CSharpFiles(Path.Combine(root, p)))
            .Where(f => CallsVerbOnAReceiverTypedAsHolder(File.ReadAllText(f), verb))
            .Select(f => Path.GetRelativePath(root, f))];

    private static readonly Regex DeclaredOrAssignedHolderReceiver = new(
        @"LoadOrderHolder\??\s+(\w+)|(\w+)\s*=(?!>)[^;]*\bLoadOrderHolder\b", RegexOptions.Compiled);

    internal static bool CallsVerbOnAReceiverTypedAsHolder(string text, string verb) =>
        DeclaredOrAssignedHolderReceiver.Matches(text)
            .SelectMany(m => new[] { m.Groups[1].Value, m.Groups[2].Value })
            .Where(name => name.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .Any(name => Regex.IsMatch(text, $@"\b{Regex.Escape(name)}\.{verb}\("));

    private static IEnumerable<string> Unallowed(List<string> named, string[] allowed) =>
        named.Where(f => !allowed.Contains(Path.GetFileName(f)));

    internal static List<string> DeadAllowances(string[] allowed, params List<string>[] scans)
    {
        var named = scans.SelectMany(s => s).Select(Path.GetFileName).ToHashSet(StringComparer.Ordinal);
        return [.. allowed.Where(a => !named.Contains(a)).Order(StringComparer.Ordinal)];
    }

    [Fact]
    public void ABareHolderReceiverName_DoesNotAnswerForAPlaceholderCall()
    {
        Assert.False(CallsVerbOnAReceiverTypedAsHolder(
            "LoadOrderHolder holder; placeholder.Apply(x);", "Apply"));
        Assert.True(CallsVerbOnAReceiverTypedAsHolder(
            "LoadOrderHolder holder; holder.Apply(x);", "Apply"));
    }

    [Fact]
    public void DeadAllowances_NamesAnAllowanceNoScanMatched_AndKeepsOneAnyScanDid()
    {
        Assert.Equal(
            ["Stale.cs"],
            DeadAllowances(["Applies.cs", "Registers.cs", "Stale.cs"], ["P/Applies.cs"], ["P/Registers.cs"]));
    }

    [Fact]
    public void TheIndexInterface_HoldsOnlyMembersTheQueryServicesCall()
    {
        var queries = SourceTree
            .CSharpFiles(Path.Combine(SolutionDirectory(), "MEditService.Queries"))
            .Select(File.ReadAllText)
            .ToList();
        var propertiesAndNonAccessorMethods = typeof(IQueryIndex).GetProperties().Select(m => m.Name)
            .Concat(typeof(IQueryIndex).GetMethods().Where(m => !m.IsSpecialName).Select(m => m.Name));
        var uncalled = propertiesAndNonAccessorMethods
            .Where(name => !queries.Exists(text => text.Contains($".{name}", StringComparison.Ordinal)))
            .ToList();
        Assert.True(uncalled.Count == 0,
            $"{nameof(IQueryIndex)} carries members no query service calls:\n" + string.Join("\n", uncalled));
    }

    [Fact]
    public void TheIndexSurface_HandsOutNoLoadOrder()
    {
        var offenders = new[] { typeof(Indexer), typeof(IQueryIndex), typeof(IRecordReads) }
            .SelectMany(type => type.GetMembers(EveryMember).Select(member => (Type: type, Member: member)))
            .Where(m => VisibleOutsideItsType(m.Member))
            .Where(m => m.Member.Name == "LoadOrder" || ReturnsALoadOrder(m.Member))
            .Select(m => $"{m.Type.Name}.{m.Member.Name}")
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(offenders.Count == 0,
            "The Index hands out a load order:\n" + string.Join("\n", offenders));
    }

    private const BindingFlags EveryMember =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

    private static bool VisibleOutsideItsType(MemberInfo member) => member switch
    {
        PropertyInfo property =>
            property.GetMethod?.IsPrivate == false || property.SetMethod?.IsPrivate == false,
        FieldInfo field => !field.IsPrivate,
        MethodBase method => !method.IsPrivate,
        _ => true,
    };

    private static bool ReturnsALoadOrder(MemberInfo member) =>
        IsALoadOrder(member switch
        {
            PropertyInfo property => property.PropertyType,
            FieldInfo field => field.FieldType,
            MethodInfo method => method.ReturnType,
            _ => null,
        });

    private static bool IsALoadOrder(Type? type) =>
        type is not null && (type == typeof(LoadOrderSnapshot) || type == typeof(LoadOrderHolder));

    [Fact]
    public void TheActivePluginRule_IsSpelledNowhereInProduction()
    {
        var root = SolutionDirectory();
        var spellings = Projects
            .SelectMany(p => SourceTree.CSharpFiles(Path.Combine(root, p)))
            .Where(file => ParticipationRule.IsMatch(File.ReadAllText(file)))
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.Empty(spellings);
    }

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

    private static readonly string[] ModFactoryCallers = ["MutagenPluginAdapter.cs", "RecordTypeDispatch.cs"];

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

    [Fact]
    public void ExistingPluginBinary_TheScanWalksMoreThanOneHundredFiles()
    {
        var root = SolutionDirectory();
        var walked = Projects.SelectMany(p => SourceTree.CSharpFiles(Path.Combine(root, p))).Count();
        Assert.True(walked > 100, $"The plugin-binary-write scan walked only {walked} files under {string.Join(", ", Projects)}.");
    }

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

    [Fact]
    public void ThePluginAdapterWriteVerb_IsCalledOnlyByThePluginWriterAndTheGesturesWithNothingToReplace()
    {
        string[] writers = ["PluginWriter.cs", "PluginTrees.cs", "CreatePluginHandler.cs"];

        string[] filesDeclaringAndImplementingTheVerbs = [.. PluginBinaryWriters, "IPluginAdapter.cs"];
        var writesIncludingCreateAndWrite = Offenders(
            SolutionDirectory(), Projects, ["PluginAdapter", "WriteAsync("],
            filesDeclaringAndImplementingTheVerbs);

        var offenders = Unallowed(writesIncludingCreateAndWrite, writers).ToList();
        Assert.True(offenders.Count == 0,
            "A plugin binary is replaced by writing a temp file and renaming it over the binary, and the "
            + "adapter's write verb writes in place. Only PluginWriter (which renames), PluginTrees (which "
            + "writes a scratch copy) and the create gesture (which writes a file with no existing binary) "
            + "may call it. It is called in:\n" + string.Join("\n", offenders));

        var dead = DeadAllowances(writers, writesIncludingCreateAndWrite).ToList();
        Assert.True(dead.Count == 0,
            "Allowances naming no such call — delete them rather than leaving a plugin write pre-authorized:\n"
            + string.Join("\n", dead));
    }

    [Fact]
    public void TestDataPlugins_AreExactlyTheAllowlist()
    {
        var testData = Path.Combine(SolutionDirectory(), "MEditService.TestSupport", "TestData");
        var allowed = SourceTree.ReadAllowlist(Path.Combine(testData, "allowed-plugins.txt"))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var present = Directory.EnumerateFiles(testData, "*.es?")
            .Select(f => Path.GetFileName(f) ?? throw new InvalidOperationException($"Expected '{f}' to have a file name."))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        Assert.Equal(allowed.Order(), present.Order());
    }

    private static readonly string[] Projects =
    ["MEditService.Codec", "MEditService.Commands", "MEditService.Http", "MEditService.Index",
         "MEditService.LoadOrder", "MEditService.PluginAdapter", "MEditService.Ports",
         "MEditService.Queries", "MEditService.SourceAdapter"];

    internal static List<string> Offenders(string root, string[] projects, string needle, string[] allowedFiles) =>
        Offenders(root, projects, [needle], allowedFiles);

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
        static void Typed(PluginAddress plugin) { }

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
