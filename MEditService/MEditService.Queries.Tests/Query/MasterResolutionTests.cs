using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public class MasterResolutionTests
{
    private static (LoadOrderEntry Registered, PluginContent? Content) Plugin(string name, params string[] masters) =>
        (new LoadOrderEntry(name, name, PluginOrigin.DataDirectory, Slot: 0, Enabled: true, Winning: true),
            new PluginContent(IsLight: false, IsMaster: false, IsBlueprint: false, masters, RecordCount: 0, IsMedium: false));

    private static (LoadOrderEntry Registered, PluginContent? Content) Disabled(string name, params string[] masters)
    {
        var (registered, content) = Plugin(name, masters);
        return (registered with { Enabled = false }, content);
    }

    private static (LoadOrderEntry Registered, PluginContent? Content) Unread(string name) => (Plugin(name).Registered, null);

    private static IReadOnlyList<PluginRow> GetPlugins(
        (LoadOrderEntry Registered, PluginContent? Content)[] plugins, LoadOrderState state = LoadOrderState.Ready)
    {
        var opened = new Dictionary<PluginAddress, PluginContent>(PluginAddress.Comparer);
        foreach (var (plugin, content) in plugins)
        {
            if (content is not null) opened[plugin.Key] = content;
        }
        var registered = plugins.Select((p, slot) => p.Registered with { Slot = slot }).ToArray();
        var holder = FakeLoadOrder.Of(GameRelease.Fallout4, registered);
        var status = new LoadOrderStatus(state, plugins.Length, plugins.Length, [], ConflictsComputed: state == LoadOrderState.Ready, []);
        var svc = QueryHost.Records(
            new FakeIndex(new FakeReads(opened, []), status), holder);

        return svc.GetPlugins();
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> Classify(
        params (LoadOrderEntry Registered, PluginContent? Content)[] plugins) =>
        GetPlugins(plugins)
            .Select(row => (row.Plugin.Name, Issues: Assert.IsAssignableFrom<IReadOnlyList<string>>(row.MasterIssues)))
            .Where(row => row.Issues.Count > 0)
            .ToDictionary(row => row.Name, row => row.Issues, StringComparer.OrdinalIgnoreCase);

    [Fact]
    public void MasterAbsentFromTheLoadOrder_IsAMasterIssue_AsMO2sTestMastersFlagsIt()
    {
        var result = Classify(Plugin("Patch.esp", "Ghost.esm"));

        Assert.Equal(["Ghost.esm"], result["Patch.esp"]);
    }

    [Fact]
    public void MasterIndexedButDisabled_IsAMasterIssue_ForMO2sTestMastersCountsAMasterOnlyWhileItIsEnabledItself()
    {
        var result = Classify(Disabled("Base.esm"), Plugin("Patch.esp", "Base.esm"));

        Assert.Equal(["Base.esm"], result["Patch.esp"]);
    }

    [Fact]
    public void ActiveMasterMEditCouldNotRead_IsNoIssue_ForTheGameLoadsWhatMEditCannotRead()
    {
        var result = Classify(Unread("Broken.esm"), Plugin("Patch.esp", "Broken.esm"));

        Assert.Empty(result);
    }

    [Fact]
    public void DisabledPluginWithAMasterAbsent_IsNoIssue_ForMO2sTestMastersFlagsNoPluginTheGameDoesNotLoad()
    {
        var result = Classify(Disabled("Patch.esp", "Ghost.esm"));

        Assert.Empty(result);
    }

    [Fact]
    public void GetPlugins_TwoPluginsOfOneName_EachCarriesItsOwnMasterIssues_ForAFilenameIsNotAnIdentity()
    {
        var (winning, missingAMaster) = Plugin("Patch.esp", "Ghost.esm");
        var (losing, complete) = Plugin("Patch.esp");

        var rows = GetPlugins([
            (winning with { Origin = "WinningMod" }, missingAMaster),
            (losing with { Origin = "LosingMod", Winning = false }, complete),
        ]);

        Assert.Equal(["Ghost.esm"], rows.Single(r => r.Plugin.Origin == "WinningMod").MasterIssues);
        Assert.Equal([], rows.Single(r => r.Plugin.Origin == "LosingMod").MasterIssues);
    }

    [Fact]
    public void MasterActive_IsNoIssue()
    {
        var result = Classify(Plugin("Base.esm"), Plugin("Patch.esp", "Base.esm"));

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    [Fact]
    public void MasterNamesMatchIgnoringCase()
    {
        var result = Classify(Plugin("Base.ESM"), Plugin("Patch.esp", "base.esm"));

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    [Fact]
    public void AMissingMastersMasterIsNotReportedAgainstTheDependent()
    {
        var aWhoseOwnMasterCIsMissing = Plugin("A.esm", "C.esm");
        var bMasteringOnlyActiveA = Plugin("B.esp", "A.esm");

        var result = Classify(aWhoseOwnMasterCIsMissing, bMasteringOnlyActiveA);

        Assert.True(result.ContainsKey("A.esm"));
        Assert.False(result.ContainsKey("B.esp"));
    }

    [Fact]
    public void PluginWithNoMastersHasNoMasterIssues()
    {
        var result = Classify(Plugin("Base.esm"));

        Assert.Empty(result);
    }

    [Theory]
    [InlineData(LoadOrderState.Reconciling)]
    [InlineData(LoadOrderState.Failed)]
    public void SnapshotNotIndexed_MasterIssuesAreNotYetCheckedNull_NotAnEmptyListMeaningNoIssues(LoadOrderState state)
    {
        var rows = GetPlugins([Plugin("A.esp", "Ghost.esm")], state);

        Assert.Null(Assert.Single(rows).MasterIssues);
    }
}
