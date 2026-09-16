using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries;

namespace MEditService.Tests.Query;

// ADR-0012: a plugin declaring a master absent from the load order is flagged, distinguishing a
// directly-missing master from one that is itself unloadable.
public class MasterResolutionTests
{
    private static (PluginCopyKey Key, PluginContent Content) Plugin(string name, params string[] masters) =>
        (new PluginCopyKey(name, "Data"), new PluginContent(IsLight: false, IsMaster: false, masters, RecordCount: 0));

    private static IReadOnlyDictionary<PluginCopyKey, PluginContent> Opened(
        params (PluginCopyKey Key, PluginContent Content)[] plugins) =>
        plugins.ToDictionary(p => p.Key, p => p.Content, PluginCopyKey.Comparer);

    [Fact]
    public void Classify_MasterAbsentFromLoadedAndFailedSets_ReturnsDirectlyMissing()
    {
        var plugins = Opened(Plugin("Patch.esp", "Ghost.esm"));

        var result = MasterResolution.Classify(plugins, failures: []);

        var issue = Assert.Single(result["Patch.esp"]);
        Assert.Equal("Ghost.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.DirectlyMissing, issue.Kind);
    }

    [Fact]
    public void Classify_MasterInFailedSet_ReturnsUnloadable()
    {
        var plugins = Opened(Plugin("Patch.esp", "Broken.esm"));
        var failures = new[] { new PluginLoadFailure("Broken.esm", "SomeMod", "Malformed record") };

        var result = MasterResolution.Classify(plugins, failures);

        var issue = Assert.Single(result["Patch.esp"]);
        Assert.Equal("Broken.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.Unloadable, issue.Kind);
    }

    [Fact]
    public void Classify_MasterSuccessfullyLoaded_ReportsNoIssue()
    {
        var plugins = Opened(Plugin("Base.esm"), Plugin("Patch.esp", "Base.esm"));

        var result = MasterResolution.Classify(plugins, failures: []);

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    [Fact]
    public void Classify_MasterNameMatchIsCaseInsensitive()
    {
        var plugins = Opened(Plugin("Base.ESM"), Plugin("Patch.esp", "base.esm"));

        var result = MasterResolution.Classify(plugins, failures: []);

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    // No transitive cascade. B masters A (A loaded fine); A itself masters missing C.
    // B's own declared-masters list is just [A] — B must not be flagged over C.
    [Fact]
    public void Classify_MastersMasterIsMissing_DoesNotCascadeToDependent()
    {
        var plugins = Opened(
            Plugin("A.esm", "C.esm"), // A itself has a missing master C
            Plugin("B.esp", "A.esm")); // B masters A only — A loaded fine

        var result = MasterResolution.Classify(plugins, failures: []);

        Assert.True(result.ContainsKey("A.esm"));
        Assert.False(result.ContainsKey("B.esp"));
    }

    [Fact]
    public void Classify_NoIssues_ReturnsEmptyDictionary()
    {
        var plugins = Opened(Plugin("Base.esm"));

        var result = MasterResolution.Classify(plugins, failures: []);

        Assert.Empty(result);
    }
}
