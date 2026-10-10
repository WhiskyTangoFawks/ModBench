using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class RecordTypeViewsTests
{
    private static readonly PluginAddress Plugin = new("Lazy.esp", PluginOrigin.DataDirectory);

    [Fact]
    public void EveryTypedRead_AnswersBeforeAnyFilter_AndAFilterNamingARecordTypeStillNarrows()
    {
        FormKey npcKey = default;
        using var fixture = new PluginFixtureBuilder("lazy-views")
            .WithPlugin(Plugin.Name, mod => npcKey = mod.Npcs.AddNew("LazyNpc").FormKey)
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var npc = npcKey.ToString();
        IReadOnlyList<RecordSummary> Listed() =>
            index.Records.GetRecords(types: null, Plugin, search: null, limit: 10, offset: 0).Value().Items;

        Assert.Equal("LazyNpc", (index.Records.GetRecord(npc).Value()
            ?? throw new InvalidOperationException($"Expected a document for '{npc}'.")).EditorId);
        Assert.Equal("LazyNpc", index.DocumentOf(npc, Plugin).EditorId);
        Assert.Contains(Listed(), i => i.FormKey == npc);
        Assert.Equal("npc_", index.ResolutionOf(npc, Plugin, npc).RecordType);
        Assert.Contains(index.Records.GetPluginRecordTypes(Plugin).Value(), c => c.Type == "npc_" && c.Count == 1);

        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'LazyNpc'", "filter.sql");

        Assert.Contains(Listed(), i => i.FormKey == npc);
        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NobodyHere'", "filter.sql");
        Assert.Empty(Listed());
    }
}
