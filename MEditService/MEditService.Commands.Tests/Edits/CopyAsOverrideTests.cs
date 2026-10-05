using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;

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

        var document = mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString());
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId, document.EditorId);

        Assert.Equal(sourceBefore, mod.SourcePluginBytes());
    }

    [Fact]
    public void CopyRecordAsOverride_FromATrackedSource_ReadsItsCurrentDocument()
    {
        using var mod = CopyFixture.Create(trackSource: true);
        var original = mod.Document(mod.SourcePlugin, mod.SourceNpc.ToString()).Require();
        mod.Overwrite(mod.SourcePlugin, original with { Body = original.Body.Replace(CopyFixture.SourceNpcEditorId, "MutatedOnDisk") });

        var result = mod.CopyHandler.CopyAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Contains(
            "MutatedOnDisk", mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString()).Require().Body, StringComparison.Ordinal);
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
            tracked.Document(tracked.DestinationPlugin, tracked.SourceNpc.ToString()).Require().Body,
            untracked.Document(untracked.DestinationPlugin, untracked.SourceNpc.ToString()).Require().Body);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CopyRecordAsOverride_Refuses_WhenTheDestinationHoldsTheFormKeyAtTheLastCommitOnly_WithOrWithoutReplace(bool replace)
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
        Assert.Contains("the last commit", result.Message, StringComparison.Ordinal);
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
