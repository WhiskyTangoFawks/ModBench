using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries;
using MEditService.Queries.Tests.TestSupport;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

// ADR-0012: a plugin declaring a master absent from the load order is flagged, distinguishing a
// directly-missing master from one that is itself unloadable. Driven through GetPlugins, the one
// public door: classification is Queries' own internal.
public class MasterResolutionTests
{
    private static (PluginCopyKey Key, PluginContent Content) Plugin(string name, params string[] masters) =>
        (new PluginCopyKey(name, "Data"), new PluginContent(IsLight: false, IsMaster: false, masters, RecordCount: 0));

    private static IReadOnlyList<PluginRow> GetPlugins(
        (PluginCopyKey Key, PluginContent Content)[] plugins, LoadOrderState state = LoadOrderState.Ready,
        params PluginLoadFailure[] failures)
    {
        var opened = plugins.ToDictionary(p => p.Key, p => p.Content, PluginCopyKey.Comparer);
        var copies = plugins
            .Select((p, slot) => new RegisteredCopy(p.Key.Name, p.Key.Origin, p.Key.Name, slot, Enabled: true, Winning: true))
            .ToList();
        var holder = FakeLoadOrder.Of(GameRelease.Fallout4, [.. copies]);
        var status = new LoadOrderStatus(state, plugins.Length, [], ConflictsComputed: state == LoadOrderState.Ready, failures);
        var svc = new RecordQueryService(
            new FakeIndex(new FakeReads(opened, []), status), holder, SharedSchemaReflector.Instance, new ConflictClassifier());

        return svc.GetPlugins();
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<MasterIssue>> Classify(
        (PluginCopyKey Key, PluginContent Content)[] plugins, params PluginLoadFailure[] failures) =>
        GetPlugins(plugins, LoadOrderState.Ready, failures)
            .Where(row => row.MasterIssues.Count > 0)
            .ToDictionary(row => row.Copy.Name, row => row.MasterIssues, StringComparer.OrdinalIgnoreCase);

    [Fact]
    public void Classify_MasterAbsentFromLoadedAndFailedSets_ReturnsDirectlyMissing()
    {
        var result = Classify([Plugin("Patch.esp", "Ghost.esm")]);

        var issue = Assert.Single(result["Patch.esp"]);
        Assert.Equal("Ghost.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.DirectlyMissing, issue.Kind);
    }

    [Fact]
    public void Classify_MasterInFailedSet_ReturnsUnloadable()
    {
        var result = Classify(
            [Plugin("Patch.esp", "Broken.esm")],
            new PluginLoadFailure("Broken.esm", "SomeMod", "Malformed record"));

        var issue = Assert.Single(result["Patch.esp"]);
        Assert.Equal("Broken.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.Unloadable, issue.Kind);
    }

    [Fact]
    public void Classify_MasterSuccessfullyLoaded_ReportsNoIssue()
    {
        var result = Classify([Plugin("Base.esm"), Plugin("Patch.esp", "Base.esm")]);

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    [Fact]
    public void Classify_MasterNameMatchIsCaseInsensitive()
    {
        var result = Classify([Plugin("Base.ESM"), Plugin("Patch.esp", "base.esm")]);

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    // No transitive cascade. B masters A (A loaded fine); A itself masters missing C.
    // B's own declared-masters list is just [A] — B must not be flagged over C.
    [Fact]
    public void Classify_MastersMasterIsMissing_DoesNotCascadeToDependent()
    {
        var result = Classify([
            Plugin("A.esm", "C.esm"), // A itself has a missing master C
            Plugin("B.esp", "A.esm"), // B masters A only — A loaded fine
        ]);

        Assert.True(result.ContainsKey("A.esm"));
        Assert.False(result.ContainsKey("B.esp"));
    }

    [Fact]
    public void Classify_NoIssues_ReturnsEmptyDictionary()
    {
        var result = Classify([Plugin("Base.esm")]);

        Assert.Empty(result);
    }

    // ADR-0012's error, suppressed while it cannot yet be told from a plugin simply not opened
    // yet (ADR-0013): GetPlugins answers no issue mid-load rather than a wrong one.
    [Fact]
    public void GetPlugins_MidLoad_DoesNotFlagAMasterThatSimplyHasNotBeenOpenedYet()
    {
        var midLoad = GetPlugins([Plugin("A.esp", "Later.esm")], LoadOrderState.Reconciling);

        var a = Assert.Single(midLoad, p => p.Copy.Name == "A.esp");
        Assert.Empty(a.MasterIssues);
    }
}
