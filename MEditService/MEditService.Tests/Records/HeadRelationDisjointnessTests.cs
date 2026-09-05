using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Records;

/// <summary><c>records_head</c>'s <c>UNION ALL</c> is exact only if its halves are disjoint. Read
/// straight off the index, since a read-time self-heal would repair the damage before it could be
/// seen.</summary>
public sealed class HeadRelationDisjointnessTests
{
    [Fact]
    public async Task ReindexingATrackedPluginWithADirtyRecord_KeepsTheUncommittedEdit_AndLeavesExactlyOneRowAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        var edited = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .EditField(mod.Plugin, mod.Npc.ToString(), "HeightMax", System.Text.Json.JsonDocument.Parse("0.75").RootElement);
        Assert.True(edited.Applied, edited.Message);

        // Precondition: the record really is dirty, so a snapshot row exists to be duplicated.
        Assert.Equal(
            WorkingTreeState.Modified,
            mod.Mirror.Index!.At(RecordRef.Effective).Search(new RecordQuery(Plugin: mod.Plugin, Limit: 100))
                .Items.Single(r => r.FormKey == mod.Npc.ToString()).WorkingTreeState);

        await ((ILoadOrderMirror)mod.Mirror).ReindexPlugin(mod.Plugin);

        // The edit survives: Effective still serves the source's 0.75, not the binary's untouched
        // value (the binary was written by the fixture and has never been compiled since).
        var effective = mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin)!;
        Assert.Equal(0.75f, Assert.IsType<float>(effective.Fields.Single(f => f.Metadata.Name == "HeightMax").Value));

        // ...and so does the divergence it created: the record is still committed-versus-working-tree
        // dirty, so it is still diffable and revertable.
        Assert.Equal(
            WorkingTreeState.Modified,
            mod.Mirror.Index!.At(RecordRef.Effective).Search(new RecordQuery(Plugin: mod.Plugin, Limit: 100))
                .Items.Single(r => r.FormKey == mod.Npc.ToString()).WorkingTreeState);

        var atHead = mod.Mirror.Index!.At(RecordRef.Head)
            .Search(new RecordQuery(Plugin: mod.Plugin, Limit: int.MaxValue))
            .Items.Count(r => string.Equals(r.FormKey, mod.Npc.ToString(), StringComparison.Ordinal));

        Assert.Equal(1, atHead);
    }

    [Fact]
    public void UnindexingAPluginWithADirtyRecord_LeavesNothingAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        var edited = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .EditField(mod.Plugin, mod.Npc.ToString(), "HeightMax", System.Text.Json.JsonDocument.Parse("0.8").RootElement);
        Assert.True(edited.Applied, edited.Message);

        mod.Mirror.Index!.Unindex(mod.Plugin);

        Assert.Null(mod.Mirror.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin));
    }
}
