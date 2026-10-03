using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsOverrideTests
{
    [Fact]
    public void CopyRecordAsOverride_FromAnUntrackedSource_LandsUnderTheSameFormKey()
    {
        using var mod = CopyFixture.Create();
        var sourceBefore = mod.SourcePluginBytes();

        var result = mod.CopyHandler.CopyAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Null(result.NewFormKey);

        var sourceFile = mod.SourceFileFor(mod.DestinationPlugin, mod.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId);
        Assert.True(File.Exists(sourceFile));

        var document = mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString());
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId, document.EditorId);

        Assert.Equal(sourceBefore, mod.SourcePluginBytes());
    }

    [Fact]
    public void CopyRecordAsOverride_FromATrackedSource_ReadsItsCurrentFileBytes()
    {
        using var mod = CopyFixture.Create(trackSource: true);
        var sourceFile = mod.SourceFileFor(mod.SourcePlugin, mod.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId);
        var mutatedText = File.ReadAllText(sourceFile).Replace(CopyFixture.SourceNpcEditorId, "MutatedOnDisk");
        File.WriteAllText(sourceFile, mutatedText);

        var result = mod.CopyHandler.CopyAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var destinationFile = mod.SourceFileFor(mod.DestinationPlugin, mod.SourceNpc, "npc_", "MutatedOnDisk");
        Assert.True(File.Exists(destinationFile));
        Assert.Contains("MutatedOnDisk", File.ReadAllText(destinationFile), StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_FromAnUntrackedSource_WritesTheSameTextATrackedSourceWould()
    {
        using var untracked = CopyFixture.Create();
        using var tracked = CopyFixture.Create(trackSource: true);

        Assert.True(untracked.CopyHandler.CopyAsOverride(
            untracked.SourcePlugin, untracked.SourceNpc.ToString(), untracked.DestinationPlugin).Applied);
        Assert.True(tracked.CopyHandler.CopyAsOverride(
            tracked.SourcePlugin, tracked.SourceNpc.ToString(), tracked.DestinationPlugin).Applied);

        Assert.Equal(
            File.ReadAllBytes(
                tracked.SourceFileFor(tracked.DestinationPlugin, tracked.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId)),
            File.ReadAllBytes(
                untracked.SourceFileFor(untracked.DestinationPlugin, untracked.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CopyRecordAsOverride_Refuses_WhenTheDestinationHoldsTheFormKeyAtHeadOnly_WithOrWithoutReplace(bool replace)
    {
        using var mod = CopyFixture.Create();
        Assert.True(mod.CopyHandler.CopyAsOverride(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin).Applied);
        mod.CommitDestination();
        Assert.Empty(mod.DeleteHandler.DeleteRecords([new RecordAt(mod.DestinationPlugin, mod.SourceNpc.ToString())]).Refused);

        var result = mod.CopyHandler.CopyAsOverride(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin, replace);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
        Assert.Contains("HEAD", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_Refuses_WhenTheSourcePluginDoesNotHoldTheRecord()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopyAsOverride(mod.SourcePlugin, "ABCDEF:Source.esm", mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }
}
