using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries.Tests.Query;

public sealed class CommittedOnlyReadPathTests
{
    private const string PluginName = "TestPlugin.esp";
    private const string Origin = "Data";
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress Plugin = new(PluginName, Origin);

    private static FakeRow Row(Fallout4Mod mod, string editorId) =>
        new(RealDocuments.Of(mod.Npcs.First(n => n.EditorID == editorId), Plugin, 0, Release));

    private static IRecordQueryService Service(params FakeRow[] rows)
    {
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [Plugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: [], RecordCount: rows.Length, IsMedium: false),
        };
        var holder = FakeLoadOrder.Of(Release, new LoadOrderEntry(PluginName, PluginName, Origin, 0, Enabled: true, Winning: true));
        return QueryHost.Records(new FakeIndex(new FakeReads(opened, rows)), holder);
    }

    private static (FormKey Npc01Key, IRecordQueryService Service) TwoNpcs()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var npc01Key = mod.Npcs.AddNew("TestNPC01").FormKey;
        mod.Npcs.AddNew("TestNPC02");
        var svc = Service(Row(mod, "TestNPC01"), Row(mod, "TestNPC02"));
        return (npc01Key, svc);
    }

    [Fact]
    public void GetCompare_OverrideCarriesTheCommittedFieldValue_AnOmittedOneReadingAsAbsent()
    {
        var (npc01Key, svc) = TwoNpcs();

        var compare = svc.GetCompare(npc01Key.ToString());

        Assert.NotNull(compare);
        var only = Assert.Single(compare.Overrides);
        Assert.Equal(PluginName, only.Plugin);
        Assert.Equal("TestNPC01", only.EditorId);
        var flags = Assert.Single(only.Fields, f => f.Metadata.Name == "MajorRecordFlagsRaw");
        Assert.Null(flags.Value);
    }
}
