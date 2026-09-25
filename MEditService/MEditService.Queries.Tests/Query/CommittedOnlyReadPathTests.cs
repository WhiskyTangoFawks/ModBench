using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries.Tests.Query;

// Plugin filtering and per-type counting are the Index's own behaviour (Index.Tests/Query/
// RecordReadsTests.cs, Index.Tests/Records/RecordTypeViewsTests.cs). What remains: a field here
// reads off the committed document, not a working-tree rebuild (ADR-0007).
public sealed class CommittedOnlyReadPathTests
{
    private const string PluginName = "TestPlugin.esp";
    private const string Origin = "Data";
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress Plugin = new(PluginName, Origin);

    private static FakeRow Row(Fallout4Mod mod, string editorId) =>
        new(Plugin, LoadOrderIndex: 0, IsWinner: true,
            RealDocuments.Of(mod.Npcs.First(n => n.EditorID == editorId), Plugin, 0, isWinner: true, Release, "npc_", ["IsDeleted"]));

    private static RecordQueryService Service(params FakeRow[] rows)
    {
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [Plugin] = new(IsLight: false, IsMaster: false, Masters: [], RecordCount: rows.Length),
        };
        var holder = FakeLoadOrder.Of(Release, new RegisteredCopy(PluginName, Origin, PluginName, 0, Enabled: true, Winning: true));
        return new(new FakeIndex(new FakeReads(opened, rows)), holder, SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    private static (FormKey Npc01Key, RecordQueryService Service) TwoNpcs()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var npc01Key = mod.Npcs.AddNew("TestNPC01").FormKey;
        mod.Npcs.AddNew("TestNPC02");
        var svc = Service(Row(mod, "TestNPC01"), Row(mod, "TestNPC02"));
        return (npc01Key, svc);
    }

    [Fact]
    public void GetCompare_OverrideCarriesTheCommittedFieldValue()
    {
        var (npc01Key, svc) = TwoNpcs();

        var compare = svc.GetCompare(npc01Key.ToString());

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
