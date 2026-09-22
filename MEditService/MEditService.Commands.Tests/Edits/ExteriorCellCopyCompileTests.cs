using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A source-tree-shape check only proves the writer believes its path; only decoding the
/// compiled binary and finding the REFR under the block/sub-block matching the source's own numbers
/// catches a writer/reader naming mismatch.</summary>
public sealed class ExteriorCellCopyCompileTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose()
    {
        foreach (var overlay in _overlays) overlay.Dispose();
        _fixture.Dispose();
    }

    private CopyRecordAsOverrideHandler CopyHandler() => _fixture.CopyAsOverrideHandler;

    private PluginCompileService CompileService() =>
        CompileServices.Over(_fixture.LoadOrder);

    [Fact]
    public async Task CopyExteriorPlacedReference_CompilesToBinary_AndPlacesTheRefUnderTheSourcesOwnBlockAndSubBlock()
    {
        var copyResult = CopyHandler().CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorPersistentRef.ToString(), _fixture.DestinationPlugin);
        Assert.True(copyResult.Applied, copyResult.Message);

        var compileResult = await CompileService().CompileAsync(_fixture.DestinationPlugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);

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

    // Shape 1: the destination overrides the WRLD but neither the target block nor sub-block.
    // The second copy lands its new block/sub-block inside the one existing worldspace directory,
    // never a sibling dir for the same WRLD.
    [Fact]
    public async Task CopyExteriorCell_WhenDestinationAlreadyOverridesTheWorldspaceOnly_LandsInsideTheExistingWorldspaceDirectory()
    {
        var service = CopyHandler();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.OtherBlockCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        // One worldspace directory total — the defect this ticket exists for is a bare-named sibling
        // — and the new block/sub-block folders exist on disk inside it.
        var worldspacesDir = Path.Combine(_fixture.DestinationSourceRoot, "Worldspaces");
        var worldspaceDir = Assert.Single(Directory.EnumerateDirectories(worldspacesDir));
        var newBlockDir = Assert.Single(Directory.EnumerateDirectories(worldspaceDir), d =>
            Path.GetFileName(d)
                .Equals($"{ContainerCopyFixture.OtherBlockX}, {ContainerCopyFixture.OtherBlockY}", StringComparison.Ordinal));
        Assert.Single(Directory.EnumerateDirectories(newBlockDir), d =>
            Path.GetFileName(d)
                .Equals($"{ContainerCopyFixture.OtherSubX}, {ContainerCopyFixture.OtherSubY}", StringComparison.Ordinal));

        var compiled = await ImportCompiled();
        var worldspace = compiled.Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace);
        var otherBlock = worldspace.SubCells.Single(
            b => b.BlockNumberX == ContainerCopyFixture.OtherBlockX && b.BlockNumberY == ContainerCopyFixture.OtherBlockY);
        var otherSub = otherBlock.Items.Single(
            sb => sb.BlockNumberX == ContainerCopyFixture.OtherSubX && sb.BlockNumberY == ContainerCopyFixture.OtherSubY);
        Assert.Contains(otherSub.Items, c => c.FormKey == _fixture.OtherBlockCell);
        // The first-copied cell survives the second mint, in its own block.
        Assert.Contains(
            worldspace.SubCells
                .Single(b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY)
                .Items.SelectMany(sb => sb.Items),
            c => c.FormKey == _fixture.ExteriorCell);
    }

    // Shape 2: only the sub-block and the cell are new. The compiled block is one block carrying
    // both sub-blocks; a sibling block directory would compile into two, or fail the round-trip gate.
    [Fact]
    public async Task CopyExteriorCell_WhenDestinationAlreadyOverridesTheBlock_CreatesTheSubBlockInsideIt()
    {
        var service = CopyHandler();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.SameBlockCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        // On disk: still one directory for the shared block, now holding both sub-block folders.
        var worldspaceDir = Assert.Single(
            Directory.EnumerateDirectories(Path.Combine(_fixture.DestinationSourceRoot, "Worldspaces")));
        var blockDir = Assert.Single(Directory.EnumerateDirectories(worldspaceDir), d =>
            Path.GetFileName(d)
                .Equals($"{ContainerCopyFixture.ExteriorBlockX}, {ContainerCopyFixture.ExteriorBlockY}", StringComparison.Ordinal));
        Assert.Equal(2, Directory.EnumerateDirectories(blockDir).Count());

        var compiled = await ImportCompiled();
        var block = compiled.Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.Single(
                b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY);
        Assert.Equal(2, block.Items.Count);
        var newSub = block.Items.Single(
            sb => sb.BlockNumberX == ContainerCopyFixture.SameBlockOtherSubX && sb.BlockNumberY == ContainerCopyFixture.SameBlockOtherSubY);
        Assert.Contains(newSub.Items, c => c.FormKey == _fixture.SameBlockCell);
    }

    // Shape 3: WRLD, block and sub-block all exist, so the copy adds exactly one cell directory
    // inside the existing sub-block and every pre-existing file keeps its exact bytes.
    [Fact]
    public async Task CopyExteriorCell_WhenDestinationAlreadyOverridesTheSubBlock_AddsTheCellAndTouchesNothingElse()
    {
        var service = CopyHandler();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var before = Directory
            .EnumerateFiles(_fixture.DestinationSourceRoot, "*", SearchOption.AllDirectories)
            .ToDictionary(f => f, File.ReadAllBytes);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.SameSubBlockCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var after = Directory
            .EnumerateFiles(_fixture.DestinationSourceRoot, "*", SearchOption.AllDirectories)
            .ToDictionary(f => f, File.ReadAllBytes);
        foreach (var (path, bytes) in before)
        {
            Assert.True(after.ContainsKey(path), $"{path} disappeared");
            Assert.True(bytes.AsSpan().SequenceEqual(after[path]), $"{path} changed bytes");
        }

        var added = after.Keys.Except(before.Keys).ToList();
        var newCellFile = Assert.Single(added);
        Assert.Contains(ContainerCopyFixture.SameSubBlockCellEditorId, File.ReadAllText(newCellFile), StringComparison.Ordinal);

        var subBlock = (await ImportCompiled()).Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.Single(
                b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY)
            .Items.Single(
                sb => sb.BlockNumberX == ContainerCopyFixture.ExteriorSubX && sb.BlockNumberY == ContainerCopyFixture.ExteriorSubY);
        Assert.Contains(subBlock.Items, c => c.FormKey == _fixture.SameSubBlockCell);
        Assert.Contains(subBlock.Items, c => c.FormKey == _fixture.ExteriorCell);
    }

    // Re-copying a cell the destination already holds replaces it in place (the container-family
    // overwrite rule): no second cell directory, no refusal, and the compiled worldspace still
    // carries exactly one copy.
    [Fact]
    public async Task CopyExteriorCell_WhenDestinationAlreadyHoldsTheCellItself_ReplacesItInPlace()
    {
        var service = CopyHandler();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var compiledCells = (await ImportCompiled()).Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.SelectMany(b => b.Items).SelectMany(sb => sb.Items)
            .Where(c => c.FormKey == _fixture.ExteriorCell);
        Assert.Single(compiledCells);
    }

    private async Task<IFallout4ModGetter> ImportCompiled()
    {
        var compileResult = await CompileService().CompileAsync(_fixture.DestinationPlugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);

        var pluginPath = Path.Combine(_fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), pluginPath), GameRelease.Fallout4);
        _overlays.Add(overlay);
        return (IFallout4ModGetter)overlay;
    }

    private readonly List<IDisposable> _overlays = [];

    // The Temporary half of "REFR in the same Persistent/Temporary slot as the source", at the wire.
    [Fact]
    public async Task CopyExteriorTemporaryPlacedReference_CompilesToBinary_InTheTemporarySlot()
    {
        var copyResult = CopyHandler().CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorTemporaryRef.ToString(), _fixture.DestinationPlugin);
        Assert.True(copyResult.Applied, copyResult.Message);

        var compileResult = await CompileService().CompileAsync(_fixture.DestinationPlugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);

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
