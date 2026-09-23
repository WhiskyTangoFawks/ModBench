using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyRecordAsOverrideHandlerTests
{
    [Fact]
    public void CopyRecordAsOverride_FromAnUntrackedSource_LandsUnderTheSameFormKey()
    {
        using var mod = CopyFixture.Create();
        var sourceBefore = mod.SourcePluginBytes();

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        // Not NewFormKey: an override echoes the caller's own FormKey rather than minting one
        // (RecordEditResult's own doc comment), so success here carries no new FormKey at all —
        // the same "success, nothing new" shape DeleteRecord's own result uses.
        Assert.Null(result.NewFormKey);

        var sourceFile = mod.SourceFileFor(mod.DestinationPlugin, mod.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId);
        Assert.True(File.Exists(sourceFile));

        var document = mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString());
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId, document.EditorId);

        // The source plugin's own file is untouched — this is a copy, not a move.
        Assert.Equal(sourceBefore, mod.SourcePluginBytes());
    }

    [Fact]
    public void CopyRecordAsOverride_IsAbsentAtHead_UntilCommittedAndCompiled()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Null(mod.CommittedDocument(
            mod.DestinationPlugin,
            new RecordIdentity(mod.SourceNpc.ToString(), "npc_", CopyFixture.SourceNpcEditorId)));
    }

    // A tracked source reads its current file, proven by mutating the file on disk after the load
    // order has been taken and observing the copy carry the mutated bytes.
    [Fact]
    public void CopyRecordAsOverride_FromATrackedSource_ReadsItsCurrentFileBytes()
    {
        using var mod = CopyFixture.Create(trackSource: true);
        var sourceFile = mod.SourceFileFor(mod.SourcePlugin, mod.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId);
        var mutatedText = File.ReadAllText(sourceFile).Replace(CopyFixture.SourceNpcEditorId, "MutatedOnDisk");
        File.WriteAllText(sourceFile, mutatedText);

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var destinationFile = mod.SourceFileFor(mod.DestinationPlugin, mod.SourceNpc, "npc_", "MutatedOnDisk");
        Assert.True(File.Exists(destinationFile));
        Assert.Contains("MutatedOnDisk", File.ReadAllText(destinationFile), StringComparison.Ordinal);
    }

    // The whole point of the untracked branch: the text is the codec's, so an untracked source's copy
    // is byte-identical to the text the tracked one would have written for the same record.
    [Fact]
    public void CopyRecordAsOverride_FromAnUntrackedSource_WritesTheSameTextATrackedSourceWould()
    {
        using var untracked = CopyFixture.Create();
        using var tracked = CopyFixture.Create(trackSource: true);

        Assert.True(untracked.CopyAsOverrideHandler.CopyRecordAsOverride(
            untracked.SourcePlugin, untracked.SourceNpc.ToString(), untracked.DestinationPlugin).Applied);
        Assert.True(tracked.CopyAsOverrideHandler.CopyRecordAsOverride(
            tracked.SourcePlugin, tracked.SourceNpc.ToString(), tracked.DestinationPlugin).Applied);

        Assert.Equal(
            File.ReadAllBytes(
                tracked.SourceFileFor(tracked.DestinationPlugin, tracked.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId)),
            File.ReadAllBytes(
                untracked.SourceFileFor(untracked.DestinationPlugin, untracked.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId)));
    }

    [Fact]
    public void CopyRecordAsOverride_Refuses_WhenTheDestinationIsUntracked_NamingTheTrackCommand()
    {
        using var mod = CopyFixture.Create();
        // The destination fixture always tracks; simulate an untracked destination the same way
        // SourceEditFixture.Untracked() does — no .git in the folder at all.
        Directory.Delete(Path.Combine(mod.DestinationModFolder, ".git"), recursive: true);

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    // Held at Head is held: a record the destination committed and then deleted in its working tree
    // is still in the compiled plugin, so its FormKey is not free.
    [Fact]
    public void CopyRecordAsOverride_Refuses_WhenTheDestinationHoldsTheFormKeyAtHeadOnly()
    {
        using var mod = CopyFixture.Create();
        Assert.True(mod.CopyAsOverrideHandler.CopyRecordAsOverride(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin).Applied);
        mod.CommitDestination();
        Assert.True(mod.DeleteHandler.DeleteRecord(mod.DestinationPlugin, mod.SourceNpc.ToString()).Applied);

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsOverride_Refuses_WhenTheSourcePluginDoesNotHoldTheRecord()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(mod.SourcePlugin, "ABCDEF:Source.esm", mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }
}
