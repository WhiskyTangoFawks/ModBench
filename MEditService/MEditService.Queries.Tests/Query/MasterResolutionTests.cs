using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

// ADR-0012 invariant 4: an active plugin is flagged for each master in its header that is not
// active, as MO2's PluginList::testMasters flags it. Driven through GetPlugins, the one public door.
public class MasterResolutionTests
{
    private static (LoadOrderEntry Registered, PluginContent? Content) Plugin(string name, params string[] masters) =>
        (new LoadOrderEntry(name, name, "Data", Slot: 0, Enabled: true, Winning: true),
            new PluginContent(IsLight: false, IsMaster: false, IsBlueprint: false, masters, RecordCount: 0));

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
        var svc = new RecordQueryService(
            new FakeIndex(new FakeReads(opened, []), status), holder, SharedSchemaReflector.Instance, new ConflictClassifier());

        return svc.GetPlugins();
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> Classify(
        params (LoadOrderEntry Registered, PluginContent? Content)[] plugins) =>
        GetPlugins(plugins)
            .Select(row => (row.Plugin.Name, Issues: Assert.IsAssignableFrom<IReadOnlyList<string>>(row.MasterIssues)))
            .Where(row => row.Issues.Count > 0)
            .ToDictionary(row => row.Name, row => row.Issues, StringComparer.OrdinalIgnoreCase);

    [Fact]
    public void MasterAbsentFromTheLoadOrder_IsAMasterIssue()
    {
        var result = Classify(Plugin("Patch.esp", "Ghost.esm"));

        Assert.Equal(["Ghost.esm"], result["Patch.esp"]);
    }

    // MO2's testMasters: a master counts only while it is enabled itself.
    [Fact]
    public void MasterIndexedButDisabled_IsAMasterIssue()
    {
        var result = Classify(Disabled("Base.esm"), Plugin("Patch.esp", "Base.esm"));

        Assert.Equal(["Base.esm"], result["Patch.esp"]);
    }

    // The game loads what mEdit cannot read, so the master is there for it.
    [Fact]
    public void ActiveMasterMEditCouldNotRead_IsNoIssue()
    {
        var result = Classify(Unread("Broken.esm"), Plugin("Patch.esp", "Broken.esm"));

        Assert.Empty(result);
    }

    // MO2's testMasters: a plugin the game does not load gets no flag.
    [Fact]
    public void DisabledPluginWithAMasterAbsent_IsNoIssue()
    {
        var result = Classify(Disabled("Patch.esp", "Ghost.esm"));

        Assert.Empty(result);
    }

    // ADR-0012 invariant 1: a filename is not an identity — each plugin answers for its own masters.
    [Fact]
    public void GetPlugins_TwoPluginsOfOneName_EachCarriesItsOwnMasterIssues()
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
    public void Classify_MasterNameMatchIsCaseInsensitive()
    {
        var result = Classify(Plugin("Base.ESM"), Plugin("Patch.esp", "base.esm"));

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    // No transitive cascade. B masters A, which is active; A itself masters missing C.
    // B's own declared-masters list is just [A] — B must not be flagged over C.
    [Fact]
    public void Classify_MastersMasterIsMissing_DoesNotCascadeToDependent()
    {
        var result = Classify(
            Plugin("A.esm", "C.esm"), // A itself has a missing master C
            Plugin("B.esp", "A.esm")); // B masters A only, which is active

        Assert.True(result.ContainsKey("A.esm"));
        Assert.False(result.ContainsKey("B.esp"));
    }

    [Fact]
    public void Classify_NoIssues_ReturnsEmptyDictionary()
    {
        var result = Classify(Plugin("Base.esm"));

        Assert.Empty(result);
    }

    // plugins.md: before the snapshot is indexed, master issues are not yet checked, which is not
    // no issues.
    [Theory]
    [InlineData(LoadOrderState.Reconciling)]
    [InlineData(LoadOrderState.Failed)]
    public void SnapshotNotIndexed_MasterIssuesAreNotYetChecked(LoadOrderState state)
    {
        var rows = GetPlugins([Plugin("A.esp", "Ghost.esm")], state);

        Assert.Null(Assert.Single(rows).MasterIssues);
    }
}
