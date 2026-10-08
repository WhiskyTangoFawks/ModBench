using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class DeleteRecordHandlerTests
{
    [Fact]
    public void DeleteRecords_LandsEachRecordOnItsOwn_AndRefusesTheOneThatCannotWithItsReason()
    {
        using var mod = SourceEditFixture.Tracked();
        var header = new RecordAt(mod.Plugin, PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName)));
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());

        var result = mod.DeleteHandler.DeleteRecordsSync([npc, header, otherNpc]);

        Assert.Equal([npc, otherNpc], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(header, refused.Item);
        Assert.Equal(RecordEditRefusal.HeaderDeleteNotSupported, refused.Refusal);
        Assert.False(string.IsNullOrWhiteSpace(refused.Message));
        Assert.Null(mod.Document(mod.Npc.ToString()));
        Assert.Null(mod.Document(mod.OtherNpc.ToString()));
        Assert.NotNull(mod.Document(header.FormKey));
    }

    [Fact]
    public void DeleteRecords_NamingOneRecordTwice_DeletesItOnce_AndRefusesNothing()
    {
        using var mod = SourceEditFixture.Tracked();
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());

        var npcSpelledOtherwise = new RecordAt(
            new PluginAddress(mod.Plugin.Name.ToUpperInvariant(), mod.Plugin.Origin.ToLowerInvariant()),
            mod.Npc.ToString().ToLowerInvariant());

        var result = mod.DeleteHandler.DeleteRecordsSync([npc, otherNpc, npc, npcSpelledOtherwise]);

        Assert.Equal([npc, otherNpc], result.Landed.Select(landed => landed.Item));
        Assert.Empty(result.Refused);
    }

    [Fact]
    public void DeleteRecords_WhenAnotherToolLeftTwoDocumentsClaimingOneRecord_RefusesThatRecord_AndLandsTheRest()
    {
        using var mod = SourceEditFixture.Tracked();
        TreeTampering.Duplicate(mod.ModFolder, mod.Plugin, mod.NpcIdentity);
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var keyword = new RecordAt(mod.Plugin, mod.Keyword.ToString());

        var result = mod.DeleteHandler.DeleteRecordsSync([otherNpc, npc, keyword]);

        Assert.Equal([otherNpc, keyword], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(npc, refused.Item);
        Assert.Equal(RecordEditRefusal.AmbiguousSourceUnit, refused.Refusal);
        Assert.Contains(mod.Npc.ToString(), refused.Message, StringComparison.Ordinal);
        Assert.Throws<AmbiguousSourceUnitException>(() => TrackedTree.Document(mod.ModFolder, mod.Plugin, mod.Npc.ToString()));
    }

    [Fact]
    public void DeleteRecords_WhenAContainersRemovalFailsPartway_PutsItsWholeTreeBack_RefusesIt_AndLandsTheRest()
    {
        using var mod = WorldspaceWithALockedCell(out var npcAt, out var worldAt, out var otherNpcAt);
        var worldDirectory = DirectoryOf(mod, "\"LockedWorld\"");
        var before = TreeTampering.FilesUnder(worldDirectory);

        var result = DeleteWhileLocked(mod, DirectoryOf(mod, "\"LockedCell\""), [npcAt, worldAt, otherNpcAt]);

        Assert.Equal([npcAt, otherNpcAt], result.Landed.Select(landed => landed.Item));
        Assert.Empty(DocumentsCarrying(mod, "\"FirstNpc\""));
        Assert.Empty(DocumentsCarrying(mod, "\"SecondNpc\""));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(worldAt, refused.Item);
        Assert.Equal(RecordEditRefusal.SourceAccessFailed, refused.Refusal);
        Assert.Contains(worldAt.FormKey, refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, TreeTampering.FilesUnder(worldDirectory));
    }

    [Fact]
    public void DeleteRecords_WhenAContainersRemovalFailsPartway_NeverWritesTheDocumentsItDidNotRemove()
    {
        using var mod = WorldspaceWithALockedCell(out _, out var worldAt, out _);
        var standing = IdentityCarrying(mod, "\"LockedCell\"");
        var writtenAt = TreeTampering.LastWrittenAt(mod.ModFolder, mod.Plugin, standing);

        var result = DeleteWhileLocked(mod, DirectoryOf(mod, "\"LockedCell\""), [worldAt]);

        Assert.Equal(worldAt, Assert.Single(result.Refused).Item);
        Assert.Equal(writtenAt, TreeTampering.LastWrittenAt(mod.ModFolder, mod.Plugin, standing));
    }

    [Fact]
    public void DeleteRecords_WhenAPathCannotBePutBack_PutsBackTheRest_AndRefusesWithTheCauseAndThatPath()
    {
        using var mod = WorldspaceWithALockedCell(out _, out var worldAt, out _);
        var cellDirectory = DirectoryOf(mod, "\"LockedCell\"");
        var freeBlock = TreeTampering.BlockDirectoryOf(mod.ModFolder, mod.Plugin, IdentityCarrying(mod, "\"FreeCell\""));
        var notes = Directory.CreateDirectory(Path.Combine(freeBlock, "Notes")).FullName;
        File.WriteAllText(Path.Combine(notes, "note.txt"), "another tool's");
        var link = Directory.CreateSymbolicLink(Path.Combine(cellDirectory, "NotesLink"), notes).FullName;
        var before = TreeTampering.FilesUnder(freeBlock);

        var result = DeleteWhileLocked(mod, cellDirectory, [worldAt]);

        var refused = Assert.Single(result.Refused);
        Assert.Contains("Access to the path", refused.Message, StringComparison.Ordinal);
        Assert.Contains(
            $"{Path.GetRelativePath(mod.ModFolder, link)} \u2014 could not be restored", refused.Message, StringComparison.Ordinal);
        Assert.Single(DocumentsCarrying(mod, "\"LockedWorld\""));
        Assert.Equal(before, TreeTampering.FilesUnder(freeBlock));
    }

    private static SourceModFixture WorldspaceWithALockedCell(out RecordAt npc, out RecordAt worldspace, out RecordAt otherNpc)
    {
        var (npcKey, worldKey, otherNpcKey) = (FormKey.Null, FormKey.Null, FormKey.Null);
        var mod = SourceModFixture.Tracked("PartwayContainer.esp", "PartwayContainerMod", plugin =>
        {
            npcKey = plugin.Npcs.AddNew("FirstNpc").FormKey;
            var world = plugin.Worldspaces.AddNew("LockedWorld");
            world.SubCells.Add(CellBlocks.Exterior(new Cell(plugin) { EditorID = "LockedCell", Grid = new CellGrid() }));
            world.SubCells.Add(CellBlocks.Exterior(
                new Cell(plugin) { EditorID = "FreeCell", Grid = new CellGrid { Point = new P2Int(32, 32) } }));
            worldKey = world.FormKey;
            otherNpcKey = plugin.Npcs.AddNew("SecondNpc").FormKey;
        });
        (npc, worldspace, otherNpc) = (
            new RecordAt(mod.Plugin, npcKey.ToString()), new RecordAt(mod.Plugin, worldKey.ToString()),
            new RecordAt(mod.Plugin, otherNpcKey.ToString()));
        return mod;
    }

    private static SelectionResult<RecordAt, RecordEditRefusal, string?> DeleteWhileLocked(SourceModFixture mod, string directory, IReadOnlyList<RecordAt> records)
    {
        FileModes.Set(directory, "500");
        try
        {
            return mod.DeleteHandler.DeleteRecordsSync(records);
        }
        finally
        {
            FileModes.Set(directory, "700");
        }
    }

    private static RecordIdentity IdentityCarrying(SourceModFixture mod, string text)
    {
        var document = DocumentsCarrying(mod, text).Single();
        return new RecordIdentity(document.FormKey, document.RecordType, document.EditorId);
    }

    private static string DirectoryOf(SourceModFixture mod, string text) =>
        TreeTampering.DirectoryOf(mod.ModFolder, mod.Plugin, IdentityCarrying(mod, text));

    private static List<SourceDocument> DocumentsCarrying(SourceModFixture mod, string text) =>
        [.. TreeDocuments.Of(SourceRepository.Over(TestMod.In(mod.ModFolder), GameRelease.Fallout4), mod.Plugin)
            .Where(document => document.Body.Contains(text, StringComparison.Ordinal))];

    [Fact]
    public void DeleteRecords_OnTheHeader_RefusesWithoutTouchingTheSourceTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, headerFormKey)]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.HeaderDeleteNotSupported, refused.Refusal);
        Assert.NotNull(mod.Document(mod.Npc.ToString()));
        Assert.NotNull(mod.Document(headerFormKey));
    }

    [Fact]
    public void DeleteRecords_RemovesTheRecord_GoneFromTheTree_StillAtHead()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        Assert.Empty(result.Refused);
        Assert.Null(mod.Document(mod.Npc.ToString()));
        Assert.True(mod.Uses(mod.Npc.ToString()));
    }

    [Fact]
    public void DeleteRecords_OnANeverCommittedRecord_LeavesNothingUsed()
    {
        using var mod = SourceEditFixture.Tracked();
        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_");
        Assert.True(created.Applied, created.Message);
        Assert.NotNull(created.NewFormKey);
        var newFormKey = created.NewFormKey;

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, newFormKey)]);

        Assert.Empty(result.Refused);
        Assert.Null(mod.Document(newFormKey));
        Assert.False(mod.Uses(newFormKey));
    }

    [Fact]
    public void DeleteRecords_LeavesOtherRecordsUntouched()
    {
        using var mod = SourceEditFixture.Tracked();

        mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        Assert.NotNull(mod.Document(mod.OtherNpc.ToString()));
    }

    [Fact]
    public void DeleteRecords_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, refused.Refusal);
        Assert.Contains("Track its mod", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteRecords_Refuses_ForAnUnknownFormKey()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, "FFFFFF:Fixture.esp")]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.RecordNotFound, refused.Refusal);
    }
}
