using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class ExteriorCellCopyCompileTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose()
    {
        _compiled.ForEach(compiled => compiled.Dispose());
        _fixture.Dispose();
    }

    private CopyRecordChangesHandler CopyHandler() => _fixture.CopyHandler;

    [Fact]
    public async Task CopyExteriorCell_WhenDestinationAlreadyOverridesTheWorldspaceOnly_LandsInsideTheExistingWorldspaceDirectory()
    {
        var service = CopyHandler();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.ExteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.OtherBlockCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();

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
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.ExteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.SameBlockCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();

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
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.ExteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var before = SourceModTree.Records(_fixture.DestinationModFolder, _fixture.DestinationPlugin);

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.SameSubBlockCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();

        var after = SourceModTree.Records(_fixture.DestinationModFolder, _fixture.DestinationPlugin);
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
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.ExteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.ExteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: true);

        result.OnlyLanded();
        var compiledCells = (await ImportCompiled()).Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.SelectMany(b => b.Items).SelectMany(sb => sb.Items)
            .Where(c => c.FormKey == _fixture.ExteriorCell);
        Assert.Single(compiledCells);
    }

    private async Task<IFallout4ModGetter> ImportCompiled()
    {
        var compiled = await _fixture.CompiledAsync(_fixture.DestinationPlugin);
        _compiled.Add(compiled);
        return compiled;
    }

    private readonly List<IDisposable> _compiled = [];
}
