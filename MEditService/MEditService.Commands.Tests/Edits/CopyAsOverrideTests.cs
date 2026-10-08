using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsOverrideTests
{
    [Fact]
    public void CopyRecordAsOverride_FromAnUntrackedSource_LandsUnderTheSameFormKey()
    {
        using var mod = CopyFixture.Create();
        var sourceBefore = mod.SourcePluginBytes();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        Assert.Null(result.OnlyLanded());

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

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.Contains(
            "MutatedOnDisk", mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString()).Require().Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_FromAnUntrackedSource_WritesTheSameTextATrackedSourceWould()
    {
        using var untracked = CopyFixture.Create();
        using var tracked = CopyFixture.Create(trackSource: true);

        untracked.CopyHandler.CopySync([new RecordAt(untracked.SourcePlugin, untracked.SourceNpc.ToString())], CopyMode.Override, [untracked.DestinationPlugin], replace: false).OnlyLanded();
        tracked.CopyHandler.CopySync([new RecordAt(tracked.SourcePlugin, tracked.SourceNpc.ToString())], CopyMode.Override, [tracked.DestinationPlugin], replace: false).OnlyLanded();

        Assert.Equal(
            tracked.Document(tracked.DestinationPlugin, tracked.SourceNpc.ToString()).Require().Body,
            untracked.Document(untracked.DestinationPlugin, untracked.SourceNpc.ToString()).Require().Body);
    }

    [Fact]
    public void CopyRecordAsOverride_OfARecordTheDestinationDeletedSinceTheLastCommit_LandsItAgain()
    {
        using var mod = CopyFixture.Create();
        mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false).OnlyLanded();
        mod.CommitDestination();
        Assert.Empty(mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.DestinationPlugin, mod.SourceNpc.ToString())]).Refused);

        mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false).OnlyLanded();

        Assert.NotNull(mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString()));
    }

    [Fact]
    public void CopyRecordAsOverride_Refuses_WhenTheSourcePluginDoesNotHoldTheRecord()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, "ABCDEF:Source.esm")], CopyMode.Override, [mod.DestinationPlugin], replace: false);
        var refused = result.OnlyRefused();

        Assert.Equal(RecordEditRefusal.RecordNotFound, refused.Refusal);
    }
}
