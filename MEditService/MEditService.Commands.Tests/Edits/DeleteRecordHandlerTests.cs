using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
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

        var result = mod.DeleteHandler.DeleteRecords([npc, header, otherNpc]);

        Assert.Equal([npc, otherNpc], result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(header, refused.Record);
        Assert.Equal(RecordEditRefusal.HeaderDeleteOrRenumberNotSupported, refused.Refusal);
        Assert.False(string.IsNullOrWhiteSpace(refused.Message));
        Assert.False(result.AllApplied);
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
            new PluginCopyKey(mod.Plugin.Name.ToUpperInvariant(), mod.Plugin.Origin.ToLowerInvariant()),
            mod.Npc.ToString().ToLowerInvariant());

        var result = mod.DeleteHandler.DeleteRecords([npc, otherNpc, npc, npcSpelledOtherwise]);

        Assert.Equal([npc, otherNpc], result.Applied);
        Assert.Empty(result.Refused);
    }

    // Another tool renamed the NPC's document and left a copy under a second name: the tree is
    // ambiguous about which one to remove, and the records either side of it still land.
    [Fact]
    public void DeleteRecords_WhenAnotherToolLeftTwoDocumentsClaimingOneRecord_RefusesThatRecord_AndLandsTheRest()
    {
        using var mod = SourceEditFixture.Tracked();
        var computed = mod.NpcSourceFile;
        string Renamed(string editorId) => Path.Combine(
            Path.GetDirectoryName(computed).Require(),
            Path.GetFileName(computed).Replace(SourceEditFixture.NpcEditorId, editorId, StringComparison.Ordinal));
        var npcFile = Renamed("RenamedByAnotherTool");
        File.Move(computed, npcFile);
        File.Copy(npcFile, Renamed("CopiedByAnotherTool"));
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var keyword = new RecordAt(mod.Plugin, mod.Keyword.ToString());

        var result = mod.DeleteHandler.DeleteRecords([otherNpc, npc, keyword]);

        Assert.Equal([otherNpc, keyword], result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(npc, refused.Record);
        Assert.Equal(RecordEditRefusal.AmbiguousSourceUnit, refused.Refusal);
        Assert.Contains(mod.Npc.ToString(), refused.Message, StringComparison.Ordinal);
        Assert.True(File.Exists(npcFile), "the refused record's document must survive");
    }

    // A cell directory nothing may write to stops the worldspace's removal partway: its own document
    // and the other block's whole subtree are gone by then, the locked cell's document is not.
    [Fact]
    public void DeleteRecords_WhenAContainersRemovalFailsPartway_PutsItsWholeTreeBack_RefusesIt_AndLandsTheRest()
    {
        var (npc, worldspace, otherNpc) = (FormKey.Null, FormKey.Null, FormKey.Null);
        using var mod = SourceModFixture.Tracked("PartwayContainer.esp", "PartwayContainerMod", plugin =>
        {
            npc = plugin.Npcs.AddNew("FirstNpc").FormKey;
            var world = plugin.Worldspaces.AddNew("LockedWorld");
            world.SubCells.Add(BlockHolding(new Cell(plugin) { EditorID = "LockedCell" }, x: 0, y: 0));
            world.SubCells.Add(BlockHolding(new Cell(plugin) { EditorID = "FreeCell" }, x: 1, y: 1));
            worldspace = world.FormKey;
            otherNpc = plugin.Npcs.AddNew("SecondNpc").FormKey;
        });
        var worldDirectory = Path.GetDirectoryName(DocumentCarrying(mod, "\"LockedWorld\"")).Require();
        var cellDirectory = Path.GetDirectoryName(DocumentCarrying(mod, "\"LockedCell\"")).Require();
        var before = FilesUnder(worldDirectory);
        var (npcAt, worldAt, otherNpcAt) = (
            new RecordAt(mod.Plugin, npc.ToString()), new RecordAt(mod.Plugin, worldspace.ToString()),
            new RecordAt(mod.Plugin, otherNpc.ToString()));

        PerRecordResult result;
        Chmod(cellDirectory, "500");
        try
        {
            result = mod.DeleteHandler.DeleteRecords([npcAt, worldAt, otherNpcAt]);
        }
        finally
        {
            Chmod(cellDirectory, "700");
        }

        Assert.Equal([npcAt, otherNpcAt], result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(worldAt, refused.Record);
        Assert.Equal(RecordEditRefusal.SourceWriteFailed, refused.Refusal);
        Assert.Contains(worldspace.ToString(), refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, FilesUnder(worldDirectory));
    }

    // One block, one sub-block and one cell, all at the block's own coordinates.
    private static WorldspaceBlock BlockHolding(Cell cell, short x, short y)
    {
        cell.Grid = new CellGrid { Point = new P2Int(x * 32, y * 32) };
        var subBlock = new WorldspaceSubBlock { BlockNumberX = (short)(x * 4), BlockNumberY = (short)(y * 4) };
        subBlock.Items.Add(cell);
        var block = new WorldspaceBlock { BlockNumberX = x, BlockNumberY = y };
        block.Items.Add(subBlock);
        return block;
    }

    private static string DocumentCarrying(SourceModFixture mod, string text) =>
        Directory.EnumerateFiles(
                Path.Combine(mod.ModFolder, SourceRepository.RootFor(mod.Plugin.Name)), "*.json", SearchOption.AllDirectories)
            .Single(file => File.ReadAllText(file).Contains(text, StringComparison.Ordinal));

    private static SortedDictionary<string, string> FilesUnder(string directory) =>
        Directory.Exists(directory)
            ? new(Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories)
                .ToDictionary(file => Path.GetRelativePath(directory, file), File.ReadAllText), StringComparer.Ordinal)
            : new(StringComparer.Ordinal);

    // Process-shelled because File.SetUnixFileMode is flagged platform-unsafe (CA1416) even on a
    // Linux-only runtime.
    private static void Chmod(string path, string mode)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "chmod", [mode, path])
        { RedirectStandardError = true }).Require();
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"chmod {mode} {path} failed: {process.StandardError.ReadToEnd()}");
    }

    [Fact]
    public void DeleteRecords_OnTheHeader_RefusesWithoutTouchingTheSourceTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));

        var result = mod.DeleteHandler.DeleteRecords([new RecordAt(mod.Plugin, headerFormKey)]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.HeaderDeleteOrRenumberNotSupported, refused.Refusal);
        Assert.True(File.Exists(mod.NpcSourceFile), "an unrelated sibling record's file must survive");
        Assert.True(
            Directory.Exists(Path.Combine(mod.ModFolder, "source", mod.ActualPluginName)),
            "the plugin's own tracked source tree must survive");
        Assert.NotNull(mod.Document(headerFormKey));
    }

    [Fact]
    public void DeleteRecords_RemovesTheSourceFile_GoneFromTheTree_StillAtHead()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.DeleteHandler.DeleteRecords([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        Assert.Empty(result.Refused);
        Assert.False(File.Exists(mod.NpcSourceFile));
        Assert.Null(mod.Document(mod.Npc.ToString()));
        // Still served by the last commit until a compile: a working-tree deletion is not a compile.
        Assert.NotNull(
            mod.CommittedDocument(mod.Npc.ToString(), "npc_", SourceEditFixture.NpcEditorId));
    }

    // ADR-0015 invariant 2: the watch over the removed file is how the deletion reaches the views.
    [Fact]
    public void DeleteRecords_PublishesNothing()
    {
        using var mod = SourceEditFixture.Tracked();
        var holder = new LoadOrderHolder();
        holder.Apply(mod.LoadOrder);
        var notifications = new InMemoryNotificationPublisher();
        var handler = TestEditService.Over(holder, notifications: notifications).GetRequiredService<DeleteRecordHandler>();

        var result = handler.DeleteRecords([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        Assert.True(result.AllApplied);
        Assert.Empty(notifications.Notifications);
    }

    [Fact]
    public void DeleteRecords_OnANeverCommittedRecord_LeavesNothingAtEitherRef()
    {
        using var mod = SourceEditFixture.Tracked();
        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNew");
        Assert.True(created.Applied, created.Message);
        Assert.NotNull(created.NewFormKey);
        var newFormKey = created.NewFormKey;

        var result = mod.DeleteHandler.DeleteRecords([new RecordAt(mod.Plugin, newFormKey)]);

        Assert.Empty(result.Refused);
        Assert.Null(mod.Document(newFormKey));
        Assert.Null(mod.CommittedDocument(newFormKey, "npc_", "BrandNew"));
    }

    [Fact]
    public void DeleteRecords_LeavesOtherRecordsUntouched()
    {
        using var mod = SourceEditFixture.Tracked();

        mod.DeleteHandler.DeleteRecords([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        Assert.NotNull(mod.Document(mod.OtherNpc.ToString()));
    }

    [Fact]
    public void DeleteRecords_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.DeleteHandler.DeleteRecords([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, refused.Refusal);
        Assert.Contains("Modbench: Track…", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteRecords_Refuses_WhileAnExternalChangeQuestionIsUnanswered()
    {
        using var mod = SourceEditFixture.Tracked();
        mod.RaiseExternalChange();

        var result = mod.DeleteHandler.DeleteRecords([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, refused.Refusal);
        Assert.True(File.Exists(mod.NpcSourceFile)); // refused before the first door — nothing written
    }

    [Fact]
    public void DeleteRecords_Refuses_ForAnUnknownFormKey()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.DeleteHandler.DeleteRecords([new RecordAt(mod.Plugin, "FFFFFF:Fixture.esp")]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.RecordNotFound, refused.Refusal);
    }
}
