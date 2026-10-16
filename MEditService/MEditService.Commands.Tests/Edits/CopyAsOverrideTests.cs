using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsOverrideTests
{
    [Fact]
    public void CopyRecordAsOverride_FromANonSourcePluginSource_LandsUnderTheSameFormKey()
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
    public void CopyRecordAsOverride_FromASourcePluginSource_ReadsItsCurrentDocument()
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
    public void CopyRecordAsOverride_FromANonSourcePluginSource_WritesTheSameTextASourcePluginSourceWould()
    {
        using var nonSourcePlugin = CopyFixture.Create();
        using var sourcePlugin = CopyFixture.Create(trackSource: true);

        nonSourcePlugin.CopyHandler.CopySync([new RecordAt(nonSourcePlugin.SourcePlugin, nonSourcePlugin.SourceNpc.ToString())], CopyMode.Override, [nonSourcePlugin.DestinationPlugin], replace: false).OnlyLanded();
        sourcePlugin.CopyHandler.CopySync([new RecordAt(sourcePlugin.SourcePlugin, sourcePlugin.SourceNpc.ToString())], CopyMode.Override, [sourcePlugin.DestinationPlugin], replace: false).OnlyLanded();

        Assert.Equal(
            sourcePlugin.Document(sourcePlugin.DestinationPlugin, sourcePlugin.SourceNpc.ToString()).Require().Body,
            nonSourcePlugin.Document(nonSourcePlugin.DestinationPlugin, nonSourcePlugin.SourceNpc.ToString()).Require().Body);
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
