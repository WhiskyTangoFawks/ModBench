using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public sealed class RecordTypeViewsTests
{
    private static readonly PluginCopyKey Plugin = new("Lazy.esp", "Data");

    [Fact]
    public void EveryTypedRead_AnswersBeforeAnyFilter_AndAFilterNamingARecordTypeStillNarrows()
    {
        FormKey npcKey = default;
        using var fixture = new PluginFixtureBuilder("lazy-views")
            .WithPlugin(Plugin.Name, mod => npcKey = mod.Npcs.AddNew("LazyNpc").FormKey)
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();
        var npc = npcKey.ToString();

        Assert.Equal("LazyNpc", (reads.GetDocument(npc)
            ?? throw new InvalidOperationException($"Expected a document for '{npc}'.")).EditorId);
        Assert.Equal("LazyNpc", (reads.GetDocument(npc, Plugin)
            ?? throw new InvalidOperationException($"Expected a document for '{npc}' in '{Plugin}'.")).EditorId);
        Assert.Contains(reads.GetDocuments(Plugin), d => d.FormKey == npc);
        Assert.Contains(reads.Search(new RecordQuery(Plugin: Plugin.Name, Origin: Plugin.Origin, Limit: 10)).Items, i => i.FormKey == npc);
        Assert.Equal("npc_", reads.Resolve(npc)?.RecordType);
        Assert.Contains(reads.GetRecordTypeCounts(Plugin), c => c.Type == "npc_" && c.Count == 1);

        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'LazyNpc'");

        Assert.Contains(reads.Search(new RecordQuery(Plugin: Plugin.Name, Origin: Plugin.Origin, Limit: 10)).Items, i => i.FormKey == npc);
        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NobodyHere'");
        Assert.Empty(reads.Search(new RecordQuery(Plugin: Plugin.Name, Origin: Plugin.Origin, Limit: 10)).Items);
    }
}
