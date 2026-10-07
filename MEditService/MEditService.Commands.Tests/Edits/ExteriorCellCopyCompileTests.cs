using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class ExteriorCellCopyCompileTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose()
    {
        foreach (var overlay in _overlays) overlay.Dispose();
        _fixture.Dispose();
    }

    private CopyRecordHandler CopyHandler() => _fixture.CopyHandler;

    private CompilePluginHandler CompileService() =>
        CompileServices.Over(_fixture.LoadOrder);

    [Fact]
    public async Task CopyExteriorPlacedReference_CompilesToBinary_AndPlacesTheRefUnderTheSourcesOwnBlockAndSubBlock()
    {
        var copyResult = CopyHandler().CopyAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorPersistentRef.ToString(), _fixture.DestinationPlugin);
        Assert.True(copyResult.Applied, copyResult.Message);

        await CompileService().CompileLandedAsync(_fixture.DestinationPlugin);

        var pluginPath = Path.Combine(_fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), pluginPath), GameRelease.Fallout4);
        var compiledMod = (IFallout4ModGetter)overlay;

        var compiledWorldspace = compiledMod.Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace);

        var block = compiledWorldspace.SubCells.SingleOrDefault(
            b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY);
        Assert.NotNull(block);

        var subBlock = block.Require().Items.SingleOrDefault(
            sb => sb.BlockNumberX == ContainerCopyFixture.ExteriorSubX && sb.BlockNumberY == ContainerCopyFixture.ExteriorSubY);
        Assert.NotNull(subBlock);

        var compiledCell = subBlock.Require().Items.SingleOrDefault(c => c.FormKey == _fixture.ExteriorCell);
        Assert.NotNull(compiledCell);

        Assert.Contains(compiledCell.Require().Persistent, r => r.FormKey == _fixture.ExteriorPersistentRef);
        Assert.DoesNotContain(compiledCell.Temporary, r => r.FormKey == _fixture.ExteriorTemporaryRef);
    }

    [Fact]
    public async Task CopyExteriorCell_WhenDestinationAlreadyOverridesTheWorldspaceOnly_LandsInsideTheExistingWorldspaceDirectory()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.OtherBlockCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        _fixture.AssertDestinationCellSitsAt(
            _fixture.OtherBlockCell.ToString(), editorId: null,
            ContainerCopyFixture.OtherBlockX, ContainerCopyFixture.OtherBlockY, ContainerCopyFixture.OtherSubX, ContainerCopyFixture.OtherSubY);

        var compiled = await ImportCompiled();
        var worldspace = compiled.Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace);
        var otherBlock = worldspace.SubCells.Single(
            b => b.BlockNumberX == ContainerCopyFixture.OtherBlockX && b.BlockNumberY == ContainerCopyFixture.OtherBlockY);
        var otherSub = otherBlock.Items.Single(
            sb => sb.BlockNumberX == ContainerCopyFixture.OtherSubX && sb.BlockNumberY == ContainerCopyFixture.OtherSubY);
        Assert.Contains(otherSub.Items, c => c.FormKey == _fixture.OtherBlockCell);
        Assert.Contains(
            worldspace.SubCells
                .Single(b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY)
                .Items.SelectMany(sb => sb.Items),
            c => c.FormKey == _fixture.ExteriorCell);
    }

    [Fact]
    public async Task CopyExteriorCell_WhenDestinationAlreadyOverridesTheBlock_CreatesTheSubBlockInsideIt()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.SameBlockCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        _fixture.AssertDestinationCellSitsAt(
            _fixture.SameBlockCell.ToString(), editorId: null,
            ContainerCopyFixture.ExteriorBlockX, ContainerCopyFixture.ExteriorBlockY, ContainerCopyFixture.SameBlockOtherSubX, ContainerCopyFixture.SameBlockOtherSubY);

        var compiled = await ImportCompiled();
        var block = compiled.Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.Single(
                b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY);
        Assert.Equal(2, block.Items.Count);
        var newSub = block.Items.Single(
            sb => sb.BlockNumberX == ContainerCopyFixture.SameBlockOtherSubX && sb.BlockNumberY == ContainerCopyFixture.SameBlockOtherSubY);
        Assert.Contains(newSub.Items, c => c.FormKey == _fixture.SameBlockCell);
    }

    [Fact]
    public async Task CopyExteriorCell_WhenDestinationAlreadyOverridesTheSubBlock_AddsTheCellAndTouchesNothingElse()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var before = TrackedTree.Records(_fixture.DestinationModFolder, _fixture.DestinationPlugin);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.SameSubBlockCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var after = TrackedTree.Records(_fixture.DestinationModFolder, _fixture.DestinationPlugin);
        Assert.All(before, document => Assert.Contains(document, after));
        var newCell = Assert.Single(after.Except(before));
        Assert.Contains(ContainerCopyFixture.SameSubBlockCellEditorId, newCell, StringComparison.Ordinal);

        var subBlock = (await ImportCompiled()).Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.Single(
                b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY)
            .Items.Single(
                sb => sb.BlockNumberX == ContainerCopyFixture.ExteriorSubX && sb.BlockNumberY == ContainerCopyFixture.ExteriorSubY);
        Assert.Contains(subBlock.Items, c => c.FormKey == _fixture.SameSubBlockCell);
        Assert.Contains(subBlock.Items, c => c.FormKey == _fixture.ExteriorCell);
    }

    [Fact]
    public async Task CopyExteriorCell_WhenDestinationAlreadyHoldsTheCellItself_ReplacesItInPlace()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        var compiledCells = (await ImportCompiled()).Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.SelectMany(b => b.Items).SelectMany(sb => sb.Items)
            .Where(c => c.FormKey == _fixture.ExteriorCell);
        Assert.Single(compiledCells);
    }

    private async Task<IFallout4ModGetter> ImportCompiled()
    {
        await CompileService().CompileLandedAsync(_fixture.DestinationPlugin);

        var pluginPath = Path.Combine(_fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), pluginPath), GameRelease.Fallout4);
        _overlays.Add(overlay);
        return (IFallout4ModGetter)overlay;
    }

    private readonly List<IDisposable> _overlays = [];

    [Fact]
    public async Task CopyExteriorTemporaryPlacedReference_CompilesToBinary_InTheTemporarySlot()
    {
        var copyResult = CopyHandler().CopyAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorTemporaryRef.ToString(), _fixture.DestinationPlugin);
        Assert.True(copyResult.Applied, copyResult.Message);

        await CompileService().CompileLandedAsync(_fixture.DestinationPlugin);

        var pluginPath = Path.Combine(_fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), pluginPath), GameRelease.Fallout4);
        var compiledCell = ((IFallout4ModGetter)overlay).Worldspaces.Records
            .Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.SelectMany(b => b.Items).SelectMany(sb => sb.Items)
            .Single(c => c.FormKey == _fixture.ExteriorCell);

        Assert.Contains(compiledCell.Temporary, r => r.FormKey == _fixture.ExteriorTemporaryRef);
        Assert.DoesNotContain(compiledCell.Persistent, r => r.FormKey == _fixture.ExteriorPersistentRef);
    }
}
