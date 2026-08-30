using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Records;

/// <summary>
/// <c>records_head</c> is <c>records_committed</c> <c>UNION ALL</c> the still-clean <c>records</c> rows,
/// and <see cref="TableDdlBuilder"/> states those halves are disjoint "by construction" — its
/// <c>UNION ALL</c> (deliberately not <c>UNION</c>) is exact only if that holds. This suite is the
/// construction being checked rather than asserted.
///
/// <para>The way to break it is to re-seed <c>records</c> for a key that still has a snapshot: two rows
/// then answer for one <c>(form_key, plugin, origin)</c>, and the read either throws or silently serves
/// one of two divergent bodies. <see cref="IRecordIndex.Index"/> clearing the snapshot table for the key
/// is what prevents it, which is part of that method's own stated contract ("replacing whatever
/// <c>key</c> previously held") rather than a new rule — it was simply unreachable until #452 gave
/// <c>Index()</c> callers that also write <c>records_committed</c>.</para>
/// </summary>
public sealed class HeadRelationDisjointnessTests
{
    /// <summary>
    /// The case no amount of care inside <c>SourceIngest</c> can cover, because it never goes near it:
    /// <see cref="ILoadOrderMirror.ReindexPlugin"/> re-reads the <i>binary</i> and calls
    /// <see cref="IRecordIndex.Index"/> straight, for a plugin whose records are already dirty.
    /// </summary>
    [Fact]
    public async Task ReindexingAPluginWithADirtyRecord_LeavesExactlyOneRowAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        var edited = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .EditField(mod.Plugin, mod.Npc.ToString(), "height_max", System.Text.Json.JsonDocument.Parse("0.75").RootElement);
        Assert.True(edited.Applied, edited.Message);

        // Precondition: the record really is dirty, so a snapshot row exists to be duplicated.
        Assert.Equal(
            WorkingTreeState.Modified,
            mod.Mirror.Index!.Search(new RecordQuery(Plugin: mod.Plugin, Limit: 100))
                .Items.Single(r => r.FormKey == mod.Npc.ToString()).WorkingTreeState);

        await ((ILoadOrderMirror)mod.Mirror).ReindexPlugin(TrackedModFixture.PluginName);

        var atHead = mod.Mirror.Index!.At(RecordRef.Head)
            .Search(new RecordQuery(Plugin: mod.Plugin, Limit: int.MaxValue))
            .Items.Count(r => string.Equals(r.FormKey, mod.Npc.ToString(), StringComparison.Ordinal));

        Assert.Equal(1, atHead);
    }

    /// <summary>The same invariant for the inverse verb: <see cref="IRecordIndex.Unindex"/> promises to
    /// remove every trace of a key, and a surviving snapshot would keep answering at Head for a plugin
    /// the load order no longer holds — the opposite of #34/ADR-0035's "hidden means absent".</summary>
    [Fact]
    public void UnindexingAPluginWithADirtyRecord_LeavesNothingAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        var edited = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .EditField(mod.Plugin, mod.Npc.ToString(), "height_max", System.Text.Json.JsonDocument.Parse("0.8").RootElement);
        Assert.True(edited.Applied, edited.Message);

        mod.Mirror.Index!.Unindex(mod.Plugin);

        Assert.Null(mod.Mirror.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin));
    }
}
