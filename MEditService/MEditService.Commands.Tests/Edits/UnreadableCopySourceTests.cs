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
