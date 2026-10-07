using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class InteriorCellCopyCompileTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();
    private readonly List<IDisposable> _overlays = [];

    public void Dispose()
    {
        foreach (var overlay in _overlays) overlay.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public async Task CopyInteriorCell_IntoAPluginHoldingNoCells_CompilesWithTheCellUnderTheMintedBlockPair()
    {
        var copy = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.InteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false);
        copy.OnlyLanded();

        var block = Assert.Single((await ImportCompiled()).Cells.Records);
        var subBlock = Assert.Single(block.SubBlocks);

        Assert.Equal(GroupTypeEnum.InteriorCellBlock, block.GroupType);
        Assert.Equal(GroupTypeEnum.InteriorCellSubBlock, subBlock.GroupType);
        Assert.Contains(subBlock.Cells, c => c.FormKey == _fixture.InteriorCell);
    }

    [Fact]
    public async Task CopyInteriorPlacedReference_IntoAPluginHoldingNoCells_CompilesWithTheRefInsideTheMintedCell()
    {
        var copy = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.PersistentRef.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false);
        copy.OnlyLanded();

        var cell = Assert.Single(
            Assert.Single(Assert.Single((await ImportCompiled()).Cells.Records).SubBlocks).Cells,
            c => c.FormKey == _fixture.InteriorCell);

        Assert.Contains(cell.Persistent, r => r.FormKey == _fixture.PersistentRef);
    }

    private async Task<IFallout4ModGetter> ImportCompiled()
    {
        await CompileServices.Over(_fixture.LoadOrder).CompileLandedAsync(_fixture.DestinationPlugin);

        var overlay = ModFactory.ImportGetter(
            new ModPath(
                ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName),
                Path.Combine(_fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName)),
            GameRelease.Fallout4);
        _overlays.Add(overlay);
        return (IFallout4ModGetter)overlay;
    }
}
