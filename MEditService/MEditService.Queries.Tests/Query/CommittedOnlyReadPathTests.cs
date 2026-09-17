using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Query;

/// <summary>The read path answers from the index alone (ADR-0007): no surface reconstructs a second
/// answer on the way out.</summary>
public sealed class CommittedOnlyReadPathTests
{
    private const string PluginName = "TestPlugin.esp";
    private const string Origin = "Data";
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginCopyKey Plugin = new(PluginName, Origin);

    private static FakeRow Row(Fallout4Mod mod, string editorId) =>
        new(Plugin, LoadOrderIndex: 0, IsWinner: true,
            RealDocuments.Of(mod.Npcs.First(n => n.EditorID == editorId), Plugin, 0, isWinner: true, Release, "npc_"));

    private static RecordQueryService Service(params FakeRow[] rows)
    {
        var opened = new Dictionary<PluginCopyKey, PluginContent>
        {
            [Plugin] = new(IsLight: false, IsMaster: false, Masters: [], RecordCount: rows.Length),
        };
        var holder = FakeLoadOrder.Of(Release, new RegisteredCopy(PluginName, Origin, PluginName, 0, Enabled: true, Winning: true));
        return new(new FakeIndex(new FakeReads(opened, rows)), holder, SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    private static (Fallout4Mod Mod, RecordQueryService Service) TwoNpcs()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("TestNPC01");
        mod.Npcs.AddNew("TestNPC02");
        var svc = Service(Row(mod, "TestNPC01"), Row(mod, "TestNPC02"));
        return (mod, svc);
    }

    [Fact]
    public void GetRecords_ForAPlugin_ReturnsExactlyTheRecordsThatPluginDeclares()
    {
        var (_, svc) = TwoNpcs();

        var result = svc.GetRecords("npc_", PluginName, search: null, limit: 100, offset: 0);

        Assert.Equal(2, result.Total);
        Assert.Equal(
            ["TestNPC01", "TestNPC02"],
            result.Items.Select(r => r.EditorId ?? "").OrderBy(e => e, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void GetPluginRecordTypes_CountsOnlyIndexedRecords()
    {
        var (_, svc) = TwoNpcs();

        var counts = svc.GetPluginRecordTypes(PluginName);

        var npcs = Assert.Single(counts, c => c.Type == "npc_");
        Assert.Equal(2, npcs.Count);
    }

    [Fact]
    public void GetCompare_OverrideCarriesTheCommittedFieldValue()
    {
        var (_, svc) = TwoNpcs();
        var formKey = svc.GetRecords("npc_", PluginName, "TestNPC01", 1, 0).Items[0].FormKey;

        var compare = svc.GetCompare(formKey);

        Assert.NotNull(compare);
        var only = Assert.Single(compare.Overrides);
        Assert.Equal(PluginName, only.Plugin);
        Assert.Equal("TestNPC01", only.EditorId);
        // A scalar field read straight off the real codec's own text — the slot a staged value could
        // otherwise stand in for. The document omits a false flag, which reads as its default.
        var deleted = Assert.Single(only.Fields, f => f.Metadata.Name == "IsDeleted");
        Assert.Null(deleted.Value);
    }
}
