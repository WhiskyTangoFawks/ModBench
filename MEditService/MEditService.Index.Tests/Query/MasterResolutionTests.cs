using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Query;

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

    private static IReadOnlyList<PluginRow> GetPlugins(PluginFixtureBuilder builder)
    {
        using var fixture = builder.Build();
        using var index = Indexes.Reconciled(fixture);
        return index.Records.GetPlugins();
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> Classify(PluginFixtureBuilder builder) =>
        GetPlugins(builder)
            .Select(row => (row.Plugin.Name, Issues: Assert.IsAssignableFrom<IReadOnlyList<string>>(row.MasterIssues)))
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

        var rows = index.Records.GetPlugins();

        Assert.DoesNotContain(rows, r => r.Plugin.Name == "Broken.esm");
        Assert.Equal([], rows.Single(r => r.Plugin.Name == "Patch.esp").MasterIssues);
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

        var rows = index.Records.GetPlugins();

        Assert.Equal(["Ghost.esm"], rows.Single(r => r.Plugin.Origin == "WinningMod").MasterIssues);
        Assert.Equal([], rows.Single(r => r.Plugin.Origin == "LosingMod").MasterIssues);
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
    public async Task WhileTheLoadOrderIsStillIndexing_MasterIssuesAreNotYetCheckedNull_NotAnEmptyListMeaningNoIssues()
    {
        using var fixture = Plugins(Plugin("A.esp", "Ghost.esm"), Plugin("B.esp")).Build();
        using var gate = new GatedPluginAdapter(gateBefore: "B.esp");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, gate);
        var load = Task.Run(() => index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        IReadOnlyList<PluginRow> rows;
        try
        {
            rows = index.Records.GetPlugins();
        }
        finally
        {
            gate.Release();
        }
        await load;

        Assert.Null(rows.Single(r => r.Plugin.Name == "A.esp").MasterIssues);
    }
}
