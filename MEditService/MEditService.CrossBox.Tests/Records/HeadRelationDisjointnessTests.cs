using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Records;

/// <summary>The committed state is one row per record, never two. Read straight off the Index,
/// since a read-time self-heal would repair the damage before it could be seen.</summary>
public sealed class HeadRelationDisjointnessTests
{
    [Fact]
    public async Task ReindexingATrackedPluginWithADirtyRecord_KeepsTheUncommittedEdit_AndOneCommittedState()
    {
        using var mod = IndexedModFixture.Tracked();

        var edited = ProjectingEditService.Over(mod.Index, mod.Holder)
            .Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", System.Text.Json.JsonDocument.Parse("0.75").RootElement);
        Assert.True(edited.Applied, edited.Message);

        // Precondition: the record really is dirty, so a snapshot row exists to be duplicated.
        Assert.Equal(
            WorkingTreeState.Modified,
            mod.Index.Projected().Search(new RecordQuery(Plugin: mod.Plugin.Name, Origin: mod.Plugin.Origin, Limit: 100))
                .Items.Single(r => r.FormKey == mod.Npc.ToString()).WorkingTreeState);

        await mod.Index.ReindexPlugin(mod.Plugin);

        // The edit survives: Effective still serves the source's 0.75, not the binary's untouched
        // value (the binary was written by the fixture and has never been compiled since).
        var effective = mod.Index.Projected().GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(effective);
        Assert.Equal(0.75f, Assert.IsType<JsonElement>(effective.Fields.Single(f => f.Metadata.Name == "HeightMax").Value).GetSingle());

        // ...and so does the divergence it created: the record is still committed-versus-working-tree
        // dirty, so it is still diffable and revertable.
        Assert.Equal(
            WorkingTreeState.Modified,
            mod.Index.Projected().Search(new RecordQuery(Plugin: mod.Plugin.Name, Origin: mod.Plugin.Origin, Limit: 100))
                .Items.Single(r => r.FormKey == mod.Npc.ToString()).WorkingTreeState);

        var stack = mod.Index.Projected().GetOverrideStack(mod.Npc.ToString());
        Assert.NotNull(stack);
        var entry = Assert.Single(stack.Entries);
        Assert.True(entry.HasWorkingTreeChange);
        Assert.NotEqual(entry.Effective.Body, entry.Head.Body);
    }

    [Fact]
    public async Task UnindexingAPluginWithADirtyRecord_LeavesNothingAtHead()
    {
        using var mod = IndexedModFixture.Tracked();

        var edited = ProjectingEditService.Over(mod.Index, mod.Holder)
            .Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", System.Text.Json.JsonDocument.Parse("0.8").RootElement);
        Assert.True(edited.Applied, edited.Message);

        var pluginPath = Path.Combine(mod.ModFolder, mod.ActualPluginName);
        File.Delete(pluginPath);
        Assert.True(await mod.Index.RefreshBinary(mod.Plugin, pluginPath));

        Assert.Null(mod.Index.RequireReads().HeadDocument(mod.Npc.ToString(), mod.Plugin));
        Assert.Null(mod.Index.IndexedContentHash(mod.Plugin));
    }
}
