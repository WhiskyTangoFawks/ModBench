using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class ExteriorCellCopyRollbackTests
{
    [Theory]
    [InlineData(CopyMode.Override, false)]
    [InlineData(CopyMode.Override, true)]
    [InlineData(CopyMode.DeepOverride, false)]
    [InlineData(CopyMode.New, true)]
    public void ACopyThatMintsTheWorldspace_AndFailsOnTheCell_LeavesTheDestinationTreeAsItWas(CopyMode mode, bool ofAPlacedReference)
    {
        using var fixture = ContainerCopyFixture.CreateWithTrackedSource();
        var cell = new RecordIdentity(fixture.ExteriorCell.ToString(), "cell", ContainerCopyFixture.ExteriorCellEditorId);
        TreeTampering.BlockWriteAsPlacedIn(
            fixture.SourceModFolder, fixture.SourcePlugin, cell, fixture.DestinationModFolder, fixture.DestinationPlugin);
        var destinationTree = PluginSourceRoot.In(fixture.DestinationModFolder, fixture.DestinationPlugin.Name);
        var before = TreeSnapshot.Of(destinationTree);

        var copied = ofAPlacedReference ? fixture.ExteriorPersistentRef : fixture.ExteriorCell;
        var result = fixture.CopyHandler.CopySync(
            [new RecordAt(fixture.SourcePlugin, copied.ToString())], mode, [fixture.DestinationPlugin], replace: false);

        Assert.Equal(RecordEditRefusal.SourceWriteFailed, Assert.Single(result.Refused).Refusal);
        Assert.Equal(before, TreeSnapshot.Of(destinationTree));
    }
}
