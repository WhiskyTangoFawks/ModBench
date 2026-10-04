using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class UnreadableCopySourceTests : IDisposable
{
    private readonly ContainerCopyFixture _mod = ContainerCopyFixture.CreateWithTrackedSource();

    public void Dispose() => _mod.Dispose();

    private void MakeNoJsonDocument(FormKey formKey)
    {
        var document = _mod.Document(_mod.SourcePlugin, formKey.ToString()).Require();
        SourceRepository.Open(_mod.SourceModFolder, GameRelease.Fallout4).Require()
            .Put(_mod.SourcePlugin, document with { Body = document.Body.Replace('{', '[') });
    }

    [Fact]
    public void CopyAsOverride_OfAReadableRecord_ChangesTheDestinationByThatRecord()
    {
        var result = _mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, _mod.FlatNpc.ToString(), _mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Equal([_mod.FlatNpc.ToString()], _mod.ChangedFormKeys(_mod.DestinationPlugin));
    }

    [Fact]
    public void CopyAsOverride_OfARecordWhoseTrackedDocumentIsNoJsonDocument_IsRefused_AndWritesNothing()
    {
        MakeNoJsonDocument(_mod.FlatNpc);

        var result = _mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, _mod.FlatNpc.ToString(), _mod.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains($"{ContainerCopyFixture.SourcePluginName}'s document for {_mod.FlatNpc} is no record document", result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
    }

    [Fact]
    public void CopyAsOverride_OntoADestinationDocumentThatIsNoJsonDocument_IsRefused_AndLeavesItAlone()
    {
        Assert.True(_mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, _mod.FlatNpc.ToString(), _mod.DestinationPlugin).Applied);
        var document = _mod.Document(_mod.DestinationPlugin, _mod.FlatNpc.ToString()).Require();
        var file = TreeTampering.FileOf(_mod.DestinationModFolder, _mod.DestinationPlugin, document.Identity);
        var broken = document.Body.Replace('{', '[');
        File.WriteAllText(file, broken);

        var result = _mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, _mod.FlatNpc.ToString(), _mod.DestinationPlugin, replace: true);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("is not a readable document", result.Message, StringComparison.Ordinal);
        Assert.Equal(broken, File.ReadAllText(file));
    }

    [Fact]
    public void CopyAsOverride_OfAChildIntoADestinationWhoseContainerDocumentIsNoJsonDocument_IsRefused_AndLeavesItAlone()
    {
        Assert.True(_mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, _mod.DialogTopic.ToString(), _mod.DestinationPlugin).Applied);
        var container = _mod.Document(_mod.DestinationPlugin, _mod.Quest.ToString()).Require();
        var file = TreeTampering.FileOf(_mod.DestinationModFolder, _mod.DestinationPlugin, container.Identity);
        var broken = container.Body.Replace('{', '[');
        File.WriteAllText(file, broken);

        var result = _mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, _mod.Scene.ToString(), _mod.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains($"{ContainerCopyFixture.DestinationPluginName}'s document for {_mod.Quest} is no record document", result.Message, StringComparison.Ordinal);
        Assert.Equal(broken, File.ReadAllText(file));
    }

    [Fact]
    public void CopyAsOverride_OntoADestinationHoldingTheRecordInTwoDocuments_IsRefusedAsAmbiguous_AndLeavesItAlone()
    {
        Assert.True(_mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, _mod.FlatNpc.ToString(), _mod.DestinationPlugin).Applied);
        var document = _mod.Document(_mod.DestinationPlugin, _mod.FlatNpc.ToString()).Require();
        TreeTampering.Duplicate(_mod.DestinationModFolder, _mod.DestinationPlugin, document.Identity);
        var before = TreeSnapshot.Of(_mod.DestinationModFolder);

        var result = _mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, _mod.FlatNpc.ToString(), _mod.DestinationPlugin, replace: true);

        Assert.Equal(RecordEditRefusal.AmbiguousSourceUnit, result.Refusal);
        Assert.Equal(before, TreeSnapshot.Of(_mod.DestinationModFolder));
    }

    [Fact]
    public void CopyAsOverride_OfAnExteriorCellWhoseWorldspaceDocumentIsNoJsonDocument_IsRefusedNamingIt_AndWritesNothing()
    {
        MakeNoJsonDocument(_mod.Worldspace);

        var result = _mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, _mod.ExteriorCell.ToString(), _mod.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("' is filed as a record", result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
    }

    [Fact]
    public void CopyAsNew_OfARecordPlacedInAnExteriorCellWhoseWorldspaceDocumentIsNoJsonDocument_IsRefusedNamingIt_AndWritesNothing()
    {
        MakeNoJsonDocument(_mod.Worldspace);

        var result = _mod.CopyHandler.CopyAsNew(_mod.SourcePlugin, _mod.ExteriorTemporaryRef.ToString(), _mod.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("' is filed as a record", result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
    }
}
