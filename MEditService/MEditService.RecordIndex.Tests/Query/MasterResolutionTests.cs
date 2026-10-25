using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Query;

public class MasterResolutionTests
{
    private static readonly BinaryWriteParameters AsDeclared = new() { MastersListContent = MastersListContentOption.NoCheck };

    private static Action<Fallout4Mod> Mastering(params string[] masters) =>
        mod => mod.ModHeader.MasterReferences.AddRange(masters.Select(master => new MasterReference { Master = ModKey.FromFileName(master) }));

    private sealed record Declared(string Name, bool Enabled, string[] Masters);

    private static Declared Plugin(string name, params string[] masters) => new(name, Enabled: true, masters);

    private static Declared Disabled(string name, params string[] masters) => new(name, Enabled: false, masters);

    private static PluginFixtureBuilder Plugins(params Declared[] plugins) =>
        plugins.Aggregate(
            new PluginFixtureBuilder("medit-master-issues"),
            (builder, plugin) => builder.WithPlugin(plugin.Name, Mastering(plugin.Masters), writeParams: AsDeclared, enabled: plugin.Enabled));

    private static IReadOnlyList<PluginResponse> GetPlugins(PluginFixtureBuilder builder)
    {
        using var fixture = builder.Build();
        using var index = Indexes.Reconciled(fixture);
        return index.Queries.GetPlugins().Value();
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> Classify(PluginFixtureBuilder builder) =>
        GetPlugins(builder)
            .Select(row => (row.Name, Issues: Assert.IsAssignableFrom<IReadOnlyList<string>>(row.MissingMasters)))
            .Where(row => row.Issues.Count > 0)
            .ToDictionary(row => row.Name, row => row.Issues, StringComparer.OrdinalIgnoreCase);

    private static readonly Dictionary<string, (Declared[] Plugins, string[] Issues)> MasterIssueCases = new()
    {
        ["a master absent from the load order is an issue, as MO2's testMasters flags it"] = ([Plugin("Patch.esp", "Ghost.esm")], ["Patch.esp: Ghost.esm"]),
        ["a master present but disabled is an issue, for MO2's testMasters counts a master only while it is enabled itself"] = ([Disabled("Base.esm"), Plugin("Patch.esp", "Base.esm")], ["Patch.esp: Base.esm"]),
        ["a disabled plugin with a master absent is no issue, for MO2's testMasters flags no plugin the game does not load"] = ([Disabled("Patch.esp", "Ghost.esm")], []),
        ["an active master is no issue"] = ([Plugin("Base.esm"), Plugin("Patch.esp", "Base.esm")], []),
        ["a master's name matches ignoring case"] = ([Plugin("Base.ESM"), Plugin("Patch.esp", "base.esm")], []),
        ["a missing master's master is not reported against the dependant"] = ([Plugin("A.esm", "C.esm"), Plugin("B.esp", "A.esm")], ["A.esm: C.esm"]),
        ["a plugin with no masters has no issue"] = ([Plugin("Base.esm")], []),
    };

    public static TheoryData<string> MasterIssueRules => [.. MasterIssueCases.Keys];

    [Theory]
    [MemberData(nameof(MasterIssueRules))]
    public void APluginsMasterIssues_AreTheMastersTheGameWouldNotFindEnabled(string rule)
    {
        var (plugins, issues) = MasterIssueCases[rule];

        var result = Classify(Plugins(plugins));

        Assert.Equal(issues, result.SelectMany(row => row.Value.Select(master => $"{row.Key}: {master}")).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void ActiveMasterMEditCouldNotRead_IsNoIssue_ForTheGameLoadsWhatMEditCannotRead()
    {
        using var fixture = Plugins(Plugin("Broken.esm"), Plugin("Patch.esp", "Broken.esm")).Build();
        File.WriteAllBytes(fixture.Plugins.Single(p => p.Name == "Broken.esm").Path, [0xDE, 0xAD]);
        using var index = Indexes.Reconciled(fixture);

        var rows = index.Queries.GetPlugins().Value();

        Assert.DoesNotContain(rows, r => r.Name == "Broken.esm");
        Assert.Equal([], rows.Single(r => r.Name == "Patch.esp").MissingMasters);
    }

    [Fact]
    public void TwoPluginsOfOneName_EachCarriesItsOwnMasterIssues_ForAFilenameIsNotAnIdentity()
    {
        using var fixture = Plugins()
            .WithPlugin("Patch.esp", Mastering(), writeParams: AsDeclared, origin: "LosingMod")
            .WithPlugin("Patch.esp", Mastering("Ghost.esm"), writeParams: AsDeclared, origin: "WinningMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);

        var rows = index.Queries.GetPlugins().Value();

        Assert.Equal(["Ghost.esm"], rows.Single(r => r.Origin == "WinningMod").MissingMasters);
        Assert.Equal([], rows.Single(r => r.Origin == "LosingMod").MissingMasters);
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> LateMasters(PluginFixtureBuilder builder) =>
        GetPlugins(builder)
            .Select(row => (row.Name, Late: Assert.IsAssignableFrom<IReadOnlyList<string>>(row.LateMasters)))
            .Where(row => row.Late.Count > 0)
            .ToDictionary(row => row.Name, row => row.Late, StringComparer.OrdinalIgnoreCase);

    private static readonly Dictionary<string, (Declared[] Plugins, string[] Late)> LateMasterCases = new()
    {
        ["a master loading after its dependant"] = ([Plugin("Patch.esp", "Base.esm"), Plugin("Base.esm")], ["Base.esm"]),
        ["a master loading before its dependant"] = ([Plugin("Base.esm"), Plugin("Patch.esp", "Base.esm")], []),
        ["a master named in another case, loading after its dependant"] = ([Plugin("Patch.esp", "base.esm"), Plugin("Base.ESM")], ["base.esm"]),
        ["an inactive master, which is missing rather than late"] = ([Plugin("Patch.esp", "Base.esm"), Disabled("Base.esm")], []),
    };

    public static TheoryData<string> LoadOrders => [.. LateMasterCases.Keys];

    [Theory]
    [MemberData(nameof(LoadOrders))]
    public void AnActiveMasterLoadingAfterItsDependant_IsLate_ForTheGameCrashesOnTheMasterOnlyWhenItComesSecond(string order)
    {
        var (plugins, late) = LateMasterCases[order];

        var result = LateMasters(Plugins(plugins));

        Assert.Equal(late, result.GetValueOrDefault("Patch.esp", []));
    }

    [Theory]
    [InlineData(new[] { "Base.esm" }, new string[0])]
    [InlineData(new[] { "Patch.esp" }, new string[0])]
    [InlineData(new[] { "Patch.esp", "Base.esm" }, new[] { "Base.esm" })]
    [InlineData(new string[0], new[] { "Base.esm" })]
    public void MasterLoadingAfterItsDependant_IsLateOnlyWithinOneBlueprintClass_ForBlueprintLastDecidesAcrossTheTwo(
        string[] blueprints, string[] late)
    {
        using var fixture = Plugins(Plugin("Patch.esp", "Base.esm"), Plugin("Base.esm")).Build();
        using var index = Indexes.Reconciled(fixture, adapter: new BlueprintPluginAdapter(blueprints.ToHashSet()));

        var row = index.Queries.GetPlugins().Value().Single(r => r.Name == "Patch.esp");

        Assert.Equal(late, row.LateMasters);
    }

    private sealed class BlueprintPluginAdapter(IReadOnlySet<string> blueprints) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Answer<(PluginContent Content, PluginFailure? Unreachable), PluginFailure> ReadContent(
            ModPath modPath, LoadOrderSnapshot loadOrder, PluginStrings strings) =>
            base.ReadContent(modPath, loadOrder, strings).Then(read =>
                (Answer<(PluginContent Content, PluginFailure? Unreachable), PluginFailure>)
                (read.Content with { IsBlueprint = blueprints.Contains(modPath.ModKey.FileName.ToString()) }, read.Unreachable));
    }

    [Fact]
    public async Task WhileTheLoadOrderIsStillIndexing_MasterProblemsAreNotYetCheckedNull_NotAnEmptyListMeaningNoIssues()
    {
        using var fixture = Plugins(Plugin("A.esp", "Ghost.esm"), Plugin("B.esp")).Build();
        using var gate = new GatedPluginAdapter(gateBefore: "B.esp");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, gate);
        var load = Task.Run(() => index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        IReadOnlyList<PluginResponse> rows;
        try
        {
            rows = index.Queries.GetPlugins().Value();
        }
        finally
        {
            gate.Release();
        }
        await load;

        var row = rows.Single(r => r.Name == "A.esp");
        Assert.Null(row.MissingMasters);
        Assert.Null(row.LateMasters);
    }
}
