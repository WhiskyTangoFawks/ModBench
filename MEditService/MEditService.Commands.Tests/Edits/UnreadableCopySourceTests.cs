using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
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
        SourceRepository.Open(TestMod.Of(_mod.SourcePlugin, _mod.SourceModFolder), GameRelease.Fallout4).Require()
            .Put(_mod.SourcePlugin, document with { Body = document.Body.Replace('{', '[') }).Wrote();
    }

    [Fact]
    public void CopyAsOverride_OfAReadableRecord_ChangesTheDestinationByThatRecord()
    {
        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.FlatNpc.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.Equal([_mod.FlatNpc.ToString()], _mod.ChangedFormKeys(_mod.DestinationPlugin));
    }

    [Fact]
    public void CopyAsOverride_OfARecordWhoseTrackedDocumentIsNoJsonDocument_IsRefused_AndWritesNothing()
    {
        MakeNoJsonDocument(_mod.FlatNpc);

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.FlatNpc.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains($"{ContainerCopyFixture.SourcePluginName}'s document for {_mod.FlatNpc} is no record document", refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
    }

    [Fact]
    public void CopyAsOverride_OntoADestinationDocumentThatIsNoJsonDocument_IsRefused_AndLeavesItAlone()
    {
        _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.FlatNpc.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: false).OnlyLanded();
        var document = _mod.Document(_mod.DestinationPlugin, _mod.FlatNpc.ToString()).Require();
        var file = TreeTampering.FileOf(_mod.DestinationModFolder, _mod.DestinationPlugin, document.Identity);
        var broken = document.Body.Replace('{', '[');
        File.WriteAllText(file, broken);

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.FlatNpc.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: true);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains("is not a readable document", refused.Message, StringComparison.Ordinal);
        Assert.Equal(broken, File.ReadAllText(file));
    }

    [Fact]
    public void CopyAsOverride_OfAChildIntoADestinationWhoseContainerDocumentIsNoJsonDocument_IsRefused_AndLeavesItAlone()
    {
        _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.DialogTopic.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: false).OnlyLanded();
        var container = _mod.Document(_mod.DestinationPlugin, _mod.Quest.ToString()).Require();
        var file = TreeTampering.FileOf(_mod.DestinationModFolder, _mod.DestinationPlugin, container.Identity);
        var broken = container.Body.Replace('{', '[');
        File.WriteAllText(file, broken);

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.Scene.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains($"{ContainerCopyFixture.DestinationPluginName}'s document for {_mod.Quest} is no record document", refused.Message, StringComparison.Ordinal);
        Assert.Equal(broken, File.ReadAllText(file));
    }

    [Fact]
    public void CopyAsOverride_OntoADestinationHoldingTheRecordInTwoDocuments_IsRefusedAsAmbiguous_AndLeavesItAlone()
    {
        _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.FlatNpc.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: false).OnlyLanded();
        var document = _mod.Document(_mod.DestinationPlugin, _mod.FlatNpc.ToString()).Require();
        TreeTampering.Duplicate(_mod.DestinationModFolder, _mod.DestinationPlugin, document.Identity);
        var before = TreeSnapshot.Of(_mod.DestinationModFolder);

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.FlatNpc.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: true);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.AmbiguousSourceUnit, refused.Refusal);
        Assert.Equal(before, TreeSnapshot.Of(_mod.DestinationModFolder));
    }

    [Fact]
    public void CopyAsOverride_OfAnExteriorCellWhoseWorldspaceDocumentIsNoJsonDocument_IsRefusedNamingIt_AndWritesNothing()
    {
        MakeNoJsonDocument(_mod.Worldspace);

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.ExteriorCell.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains("' is filed as a record", refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
    }

    [Fact]
    public void CopyAsNew_OfARecordPlacedInAnExteriorCellWhoseWorldspaceDocumentIsNoJsonDocument_IsRefusedNamingIt_AndWritesNothing()
    {
        MakeNoJsonDocument(_mod.Worldspace);

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.ExteriorTemporaryRef.ToString())], CopyMode.New, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains("' is filed as a record", refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
    }
}
