using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A minted interior block level has no Track-written document behind it, so only
/// compiling the tree and reading the block back out of the binary proves the level the repository
/// spelled is one the reader accepts.</summary>
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
        var copy = _fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin);
        Assert.True(copy.Applied, copy.Message);

        var block = Assert.Single((await ImportCompiled()).Cells.Records);
        var subBlock = Assert.Single(block.SubBlocks);

        Assert.Equal(GroupTypeEnum.InteriorCellBlock, block.GroupType);
        Assert.Equal(GroupTypeEnum.InteriorCellSubBlock, subBlock.GroupType);
        Assert.Contains(subBlock.Cells, c => c.FormKey == _fixture.InteriorCell);
    }

    // The reference auto-creates its cell, so the same mint runs from the other direction and the
    // child has to arrive inside the cell the minted bucket holds.
    [Fact]
    public async Task CopyInteriorPlacedReference_IntoAPluginHoldingNoCells_CompilesWithTheRefInsideTheMintedCell()
    {
        var copy = _fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin);
        Assert.True(copy.Applied, copy.Message);

        var cell = Assert.Single(
            Assert.Single(Assert.Single((await ImportCompiled()).Cells.Records).SubBlocks).Cells,
            c => c.FormKey == _fixture.InteriorCell);

        Assert.Contains(cell.Persistent, r => r.FormKey == _fixture.PersistentRef);
    }

    private async Task<IFallout4ModGetter> ImportCompiled()
    {
        var compiled = await CompileServices.Over(_fixture.LoadOrder)
            .CompileAsync(_fixture.DestinationPlugin, new CompileSource.WorkingTree());
        Assert.True(compiled.Succeeded, compiled.RefusalReason);

        var overlay = ModFactory.ImportGetter(
            new ModPath(
                ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName),
                Path.Combine(_fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName)),
            GameRelease.Fallout4);
        _overlays.Add(overlay);
        return (IFallout4ModGetter)overlay;
    }
}
