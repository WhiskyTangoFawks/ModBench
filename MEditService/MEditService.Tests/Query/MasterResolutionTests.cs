using MEditService.Core.Plugins;
using MEditService.Core.Queries;

namespace MEditService.Tests.Query;

// ADR-0037: a plugin declaring a master absent from the load order is flagged, distinguishing
// a directly-missing master (never attempted) from one that is itself unloadable (attempted,
// recorded in LoadOrder.LoadFailures) — a pure set-difference over data the load order already has,
// never a Mutagen re-read. No cascade: only a plugin's own Masters list is consulted, never a
// master's own Masters.
public class MasterResolutionTests
{
    private static PluginMetadata Plugin(string name, params string[] masters) =>
        new(name, "", 0, IsLight: false, IsMaster: false, masters, RecordCount: 0, IsForced: false, Origin: "Data", Enabled: true, Winning: true);

    [Fact]
    public void Classify_MasterAbsentFromLoadedAndFailedSets_ReturnsDirectlyMissing()
    {
        var plugins = new[] { Plugin("Patch.esp", "Ghost.esm") };

        var result = MasterResolution.Classify(plugins, failures: []);

        var issue = Assert.Single(result["Patch.esp"]);
        Assert.Equal("Ghost.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.DirectlyMissing, issue.Kind);
    }

    [Fact]
    public void Classify_MasterInFailedSet_ReturnsUnloadable()
    {
        var plugins = new[] { Plugin("Patch.esp", "Broken.esm") };
        var failures = new[] { new PluginLoadFailure("Broken.esm", "Malformed record") };

        var result = MasterResolution.Classify(plugins, failures);

        var issue = Assert.Single(result["Patch.esp"]);
        Assert.Equal("Broken.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.Unloadable, issue.Kind);
    }

    [Fact]
    public void Classify_MasterSuccessfullyLoaded_ReportsNoIssue()
    {
        var plugins = new[] { Plugin("Base.esm"), Plugin("Patch.esp", "Base.esm") };

        var result = MasterResolution.Classify(plugins, failures: []);

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    [Fact]
    public void Classify_MasterNameMatchIsCaseInsensitive()
    {
        var plugins = new[] { Plugin("Base.ESM"), Plugin("Patch.esp", "base.esm") };

        var result = MasterResolution.Classify(plugins, failures: []);

        Assert.False(result.ContainsKey("Patch.esp"));
    }

    // No transitive cascade. B masters A (A loaded fine); A itself masters missing C.
    // B's own declared-masters list is just [A] — B must not be flagged over C.
    [Fact]
    public void Classify_MastersMasterIsMissing_DoesNotCascadeToDependent()
    {
        var plugins = new[]
        {
            Plugin("A.esm", "C.esm"), // A itself has a missing master C
            Plugin("B.esp", "A.esm"), // B masters A only — A loaded fine
        };

        var result = MasterResolution.Classify(plugins, failures: []);

        Assert.True(result.ContainsKey("A.esm"));
        Assert.False(result.ContainsKey("B.esp"));
    }

    [Fact]
    public void Classify_NoIssues_ReturnsEmptyDictionary()
    {
        var plugins = new[] { Plugin("Base.esm") };

        var result = MasterResolution.Classify(plugins, failures: []);

        Assert.Empty(result);
    }
}
