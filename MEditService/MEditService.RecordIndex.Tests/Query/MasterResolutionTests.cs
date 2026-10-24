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

    [Fact]
    public void MasterAbsentFromTheLoadOrder_IsAMasterIssue_AsMO2sTestMastersFlagsIt()
    {
        var result = Classify(Plugins(Plugin("Patch.esp", "Ghost.esm")));

        Assert.Equal(["Ghost.esm"], result["Patch.esp"]);
    }

    [Fact]
    public void MasterPresentButDisabled_IsAMasterIssue_ForMO2sTestMastersCountsAMasterOnlyWhileItIsEnabledItself()
    {
        var result = Classify(Plugins(Disabled("Base.esm"), Plugin("Patch.esp", "Base.esm")));

        Assert.Equal(["Base.esm"], result["Patch.esp"]);
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
    public void DisabledPluginWithAMasterAbsent_IsNoIssue_ForMO2sTestMastersFlagsNoPluginTheGameDoesNotLoad()
    {
        var result = Classify(Plugins(Disabled("Patch.esp", "Ghost.esm")));

        Assert.Empty(result);
    }

    [Fact]
    public void GetPlugins_TwoPluginsOfOneName_EachCarriesItsOwnMasterIssues_ForAFilenameIsNotAnIdentity()
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

    [Theory]
    [InlineData(false, "Base.esm", "Base.esm", true)]
    [InlineData(true, "Base.esm", "Base.esm", false)]
    [InlineData(false, "base.esm", "Base.ESM", true)]
    public void MasterLoadingAfterItsDependant_IsLate_ForTheGameCrashesOnTheMasterOnlyWhenItComesSecond(
        bool masterFirst, string declared, string fileName, bool late)
    {
        var master = Plugin(fileName);
        var dependant = Plugin("Patch.esp", declared);

        var result = LateMasters(Plugins(masterFirst ? [master, dependant] : [dependant, master]));

        Assert.Equal(late ? [declared] : [], result.GetValueOrDefault("Patch.esp", []));
    }

    [Fact]
    public void InactiveMaster_IsNotAlsoALateMaster()
    {
        var result = LateMasters(Plugins(Plugin("Patch.esp", "Base.esm"), Disabled("Base.esm")));

        Assert.Empty(result);
    }

    [Theory]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, true)]
    [InlineData(false, false, true)]
    public void MasterLoadingAfterItsDependant_IsLateOnlyWithinOneBlueprintClass_ForBlueprintLastDecidesAcrossTheTwo(
        bool dependantIsBlueprint, bool masterIsBlueprint, bool late)
    {
        using var fixture = Plugins(Plugin("Patch.esp", "Base.esm"), Plugin("Base.esm")).Build();
        var blueprints = new[] { ("Patch.esp", dependantIsBlueprint), ("Base.esm", masterIsBlueprint) }
            .Where(plugin => plugin.Item2).Select(plugin => plugin.Item1).ToHashSet();
        using var index = Indexes.Reconciled(fixture, adapter: new BlueprintPluginAdapter(blueprints));

        var row = index.Queries.GetPlugins().Value().Single(r => r.Name == "Patch.esp");

        Assert.Equal(late ? ["Base.esm"] : [], row.LateMasters);
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
    public void MasterActive_IsNoIssue()
    {
        var result = Classify(Plugins(Plugin("Base.esm"), Plugin("Patch.esp", "Base.esm")));

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    [Fact]
    public void MasterNamesMatchIgnoringCase()
    {
        var result = Classify(Plugins(Plugin("Base.ESM"), Plugin("Patch.esp", "base.esm")));

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    [Fact]
    public void AMissingMastersMasterIsNotReportedAgainstTheDependent()
    {
        var result = Classify(Plugins(Plugin("A.esm", "C.esm"), Plugin("B.esp", "A.esm")));

        Assert.True(result.ContainsKey("A.esm"));
        Assert.False(result.ContainsKey("B.esp"));
    }

    [Fact]
    public void PluginWithNoMastersHasNoMasterIssues()
    {
        var result = Classify(Plugins(Plugin("Base.esm")));

        Assert.Empty(result);
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
