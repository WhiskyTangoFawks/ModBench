using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class UnreadableCopySourceTests : IDisposable
{
    private readonly ContainerCopyFixture _mod = ContainerCopyFixture.CreateWithCompiledPluginSource();

    public void Dispose() => _mod.Dispose();

    private void MakeNoJsonDocument(FormKey formKey)
    {
        var document = _mod.Document(_mod.SourcePlugin, formKey.ToString()).Require();
        TestAdapters.Source().Open(TestMod.Of(_mod.SourcePlugin, _mod.SourceModFolder), GameRelease.Fallout4).Require()
            .Put(_mod.SourcePlugin, document with { Body = document.Body.Replace('{', '[') }).Wrote();
    }

    [Fact]
    public void CopyAsOverride_OfARecordTwoDocumentsOfItsSourceClaim_IsRefusedAsAmbiguous_NamingTheClaim_AndWritesNothing()
    {
        var document = _mod.Document(_mod.SourcePlugin, _mod.FlatNpc.ToString()).Require();
        TreeTampering.Duplicate(_mod.SourceModFolder, _mod.SourcePlugin, document.Identity);

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.FlatNpc.ToString())], CopyMode.Override, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.AmbiguousSourceUnit, refused.Refusal);
        Assert.Contains($"More than one document in this plugin's source tree holds {_mod.FlatNpc}", refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
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

    public static TheoryData<Func<ContainerCopyFixture, FormKey>, CopyMode> CopiesReadingTheWorldspace => new()
    {
        { f => f.ExteriorCell, CopyMode.Override },
        { f => f.ExteriorTemporaryRef, CopyMode.New },
    };

    [Theory]
    [MemberData(nameof(CopiesReadingTheWorldspace))]
    public void ACopyReadingAnExteriorCellsWorldspace_WhoseDocumentIsNoJsonDocument_IsRefusedNamingIt_AndWritesNothing(
        Func<ContainerCopyFixture, FormKey> record, CopyMode mode)
    {
        MakeNoJsonDocument(_mod.Worldspace);

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, record(_mod).ToString())], mode, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains("' is filed as a record", refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
    }
}
