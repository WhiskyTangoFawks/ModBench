using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

public sealed class RecordTypeViewsTests
{
    private static readonly PluginKey Plugin = new("Lazy.esp", "Data");

    private static (DuckDbRecordIndex Index, string NpcFormKey) IndexedPlugin()
    {
        var index = new DuckDbRecordIndex(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance), NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);

        var mod = new Fallout4Mod(ModKey.FromFileName(Plugin.Name), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("LazyNpc");
        index.IndexMod(mod, Registration.Participating(0), Plugin);
        index.UpdateWinners();
        return (index, npc.FormKey.ToString());
    }

    private static HashSet<string> ViewNames(DuckDbRecordIndex index)
    {
        using var cmd = index.Connection.CreateCommand();
        cmd.CommandText = "SELECT view_name FROM duckdb_views() WHERE NOT internal";
        using var reader = cmd.ExecuteReader();
        var names = new HashSet<string>(StringComparer.Ordinal);
        while (reader.Read()) names.Add(reader.GetString(0));
        return names;
    }

    [Fact]
    public void EveryTypedRead_AnswersWithoutThePerTypeViews_WhichOnlyTheFirstFilterCreates()
    {
        var (index, npc) = IndexedPlugin();
        using var _ = index;
        var reads = index.At(RecordRef.Effective);

        Assert.Equal("LazyNpc", reads.GetDocument(npc)!.EditorId);
        Assert.Equal("LazyNpc", reads.GetDocument(npc, Plugin)!.EditorId);
        Assert.Contains(reads.GetDocuments(Plugin), d => d.FormKey == npc);
        Assert.Contains(reads.Search(new RecordQuery(Plugin: Plugin, Limit: 10)).Items, i => i.FormKey == npc);
        Assert.Equal("npc_", reads.Resolve(npc)?.RecordType);
        Assert.Contains(reads.GetRecordTypeCounts(Plugin), c => c.Type == "npc_" && c.Count == 1);
        Assert.Contains("records", ViewNames(index));
        Assert.DoesNotContain("npc_", ViewNames(index));

        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'LazyNpc'");

        Assert.Contains("npc_", ViewNames(index));
        Assert.Contains("header", ViewNames(index));
        Assert.Contains(reads.Search(new RecordQuery(Plugin: Plugin, Limit: 10)).Items, i => i.FormKey == npc);
    }
}
