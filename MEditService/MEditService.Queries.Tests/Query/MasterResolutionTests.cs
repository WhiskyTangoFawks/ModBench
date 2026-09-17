using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries;
using MEditService.Tests;
using Mutagen.Bethesda;

namespace MEditService.Tests.Query;

// ADR-0012: a plugin declaring a master absent from the load order is flagged, distinguishing a
// directly-missing master from one that is itself unloadable. Driven through GetPlugins, the one
// public door: classification is Queries' own internal.
public class MasterResolutionTests
{
    private sealed class StubReader(IReadOnlyDictionary<PluginCopyKey, PluginContent> opened) : IRecordReads
    {
        public IReadOnlyDictionary<PluginCopyKey, PluginContent> OpenedCopies => opened;
        public IReadOnlySet<string> GetPluginsWithParseFailures() => new HashSet<string>();
        public RecordDocument? GetDocument(string formKey) => null;
        public RecordDocument? GetDocument(string formKey, PluginCopyKey plugin) => null;
        public IReadOnlyList<RecordDocument> GetDocuments(PluginCopyKey plugin) => [];
        public RecordOverrides? GetOverrideStack(string formKey) => null;
        public PagedResult<RecordSummary> Search(RecordQuery query) => new([], 0);
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginCopyKey plugin) => [];
        public RecordLookupEntry? Resolve(string formKey) => null;
        public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => [];
        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) => new HashSet<string>();
        public IReadOnlySet<string> GetWorldspacesWithFailuresBelow(PluginCopyKey plugin) => new HashSet<string>();
        public IReadOnlyList<string> GetNativeFormKeys(PluginCopyKey plugin) => [];
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginCopyKey plugin, string worldspaceFormKey) => [];
        public PagedResult<CellSummary> GetInteriorCells(PluginCopyKey plugin, int limit, int offset) => new([], 0);
        public CellReferences GetCellReferences(PluginCopyKey plugin, string cellFormKey) => new([], []);
        public PlacementRow? GetPlacement(string formKey, PluginCopyKey plugin) => null;
        public CellLocationRow? GetCellLocation(PluginCopyKey plugin, string cellFormKey) => null;
        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginCopyKey plugin, string parentFormKey) => [];
        public ContainerChildRow? GetContainerParent(PluginCopyKey plugin, string childFormKey) => null;
    }

    private sealed class StubIndex(IRecordReads reads, IReadOnlyList<PluginLoadFailure> failures) : IQueryIndex
    {
        public LoadOrderStatus Status => new(LoadOrderState.Ready, 0, [], ConflictsComputed: true, failures);
        public string? FilterSql => null;
        public IRecordReads RequireReads() => reads;
    }

    private static (PluginCopyKey Key, PluginContent Content) Plugin(string name, params string[] masters) =>
        (new PluginCopyKey(name, "Data"), new PluginContent(IsLight: false, IsMaster: false, masters, RecordCount: 0));

    private static IReadOnlyDictionary<string, IReadOnlyList<MasterIssue>> Classify(
        (PluginCopyKey Key, PluginContent Content)[] plugins, params PluginLoadFailure[] failures)
    {
        var opened = plugins.ToDictionary(p => p.Key, p => p.Content, PluginCopyKey.Comparer);
        var holder = new LoadOrderHolder();
        var copies = plugins
            .Select((p, slot) => new RegisteredCopy(p.Key.Name, p.Key.Origin, p.Key.Name, slot, Enabled: true, Winning: true))
            .ToList();
        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, copies));
        var svc = new RecordQueryService(
            new StubIndex(new StubReader(opened), failures), holder, SharedSchemaReflector.Instance, new ConflictClassifier());

        return svc.GetPlugins()
            .Where(row => row.MasterIssues.Count > 0)
            .ToDictionary(row => row.Copy.Name, row => row.MasterIssues, StringComparer.OrdinalIgnoreCase);
    }

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
}
