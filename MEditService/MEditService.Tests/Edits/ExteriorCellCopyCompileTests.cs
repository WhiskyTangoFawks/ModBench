using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// The binary-level guard for exterior-cell copy. A source-tree-shape check alone (assert a file
/// exists at some computed path) only proves this feature's own writer believes it wrote the right
/// path — it cannot catch a write/reader naming mismatch, where the folder looks right by string
/// comparison but the whole-mod door's own reader (the same one <see cref="PluginCompileService"/>
/// uses to compile) either silently drops the cell (a <c>P2Int16.TryParse</c> failure on the folder
/// name returns <see langword="default"/>, filtered out by <c>.NotNull()</c> with no error) or parses
/// it into a different real block/sub-block bucket than the one it was written under. Only decoding
/// the actual compiled binary and finding the REFR nested under the block/sub-block <i>matching the
/// source's own numbers</i> — not merely "some" pair, and not merely "compiled without throwing" —
/// catches both failure modes; a source-tree-shape assertion passes on all of them.
/// </summary>
public sealed class ExteriorCellCopyCompileTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose()
    {
        foreach (var overlay in _overlays) overlay.Dispose();
        _fixture.Dispose();
    }

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private PluginCompileService CompileService() =>
        new(_fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    [Fact]
    public void CopyExteriorPlacedReference_CompilesToBinary_AndPlacesTheRefUnderTheSourcesOwnBlockAndSubBlock()
    {
        var copyResult = EditService().CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorPersistentRef.ToString(), _fixture.DestinationPlugin);
        Assert.True(copyResult.Applied, copyResult.Message);

        var compileResult = CompileService().Compile(_fixture.DestinationPlugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);

        var pluginPath = Path.Combine(_fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), pluginPath), GameRelease.Fallout4);
        var compiledMod = (IFallout4ModGetter)overlay;

        var compiledWorldspace = compiledMod.Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace);

        var block = compiledWorldspace.SubCells.SingleOrDefault(
            b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY);
        Assert.NotNull(block);

        var subBlock = block!.Items.SingleOrDefault(
            sb => sb.BlockNumberX == ContainerCopyFixture.ExteriorSubX && sb.BlockNumberY == ContainerCopyFixture.ExteriorSubY);
        Assert.NotNull(subBlock);

        var compiledCell = subBlock!.Items.SingleOrDefault(c => c.FormKey == _fixture.ExteriorCell);
        Assert.NotNull(compiledCell);

        Assert.Contains(compiledCell!.Persistent, r => r.FormKey == _fixture.ExteriorPersistentRef);
        Assert.DoesNotContain(compiledCell.Temporary, r => r.FormKey == _fixture.ExteriorTemporaryRef);
    }

    // #597 shape 1 — the destination already overrides the WRLD (from a prior copy) but neither the
    // target block nor sub-block. The second copy lands its new block/sub-block *inside* the one
    // existing worldspace directory (never a sibling dir for the same WRLD), and the compiled binary
    // carries both cells under their own distinct blocks.
    [Fact]
    public void CopyExteriorCell_WhenDestinationAlreadyOverridesTheWorldspaceOnly_LandsInsideTheExistingWorldspaceDirectory()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.OtherBlockCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        // One worldspace directory total — the defect this ticket exists for is a bare-named sibling.
        var worldspacesDir = Path.Combine(_fixture.DestinationSourceRoot, "Worldspaces");
        Assert.Single(Directory.EnumerateDirectories(worldspacesDir));

        var compiled = ImportCompiled();
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

    // #597 shape 2 — the destination already overrides the WRLD and the target block; only the
    // sub-block (and the cell) are new. The compiled block is one block carrying both sub-blocks —
    // a sibling block directory for the same coordinates would compile into two blocks, or fail
    // the round-trip gate outright.
    [Fact]
    public void CopyExteriorCell_WhenDestinationAlreadyOverridesTheBlock_CreatesTheSubBlockInsideIt()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.SameBlockCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var compiled = ImportCompiled();
        var block = compiled.Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.Single(
                b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY);
        Assert.Equal(2, block.Items.Count);
        var newSub = block.Items.Single(
            sb => sb.BlockNumberX == ContainerCopyFixture.SameBlockOtherSubX && sb.BlockNumberY == ContainerCopyFixture.SameBlockOtherSubY);
        Assert.Contains(newSub.Items, c => c.FormKey == _fixture.SameBlockCell);
    }

    // #597 shape 3 — WRLD, block and sub-block all exist; the copy adds exactly one new cell
    // directory inside the existing sub-block and changes nothing else in the tree: every
    // pre-existing file (the worldspace's own document included) keeps its exact bytes.
    [Fact]
    public void CopyExteriorCell_WhenDestinationAlreadyOverridesTheSubBlock_AddsTheCellAndTouchesNothingElse()
    {
        var service = EditService();
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

        var subBlock = ImportCompiled().Worldspaces.Records.Single(w => w.FormKey == _fixture.Worldspace)
            .SubCells.Single(
                b => b.BlockNumberX == ContainerCopyFixture.ExteriorBlockX && b.BlockNumberY == ContainerCopyFixture.ExteriorBlockY)
            .Items.Single(
                sb => sb.BlockNumberX == ContainerCopyFixture.ExteriorSubX && sb.BlockNumberY == ContainerCopyFixture.ExteriorSubY);
        Assert.Contains(subBlock.Items, c => c.FormKey == _fixture.SameSubBlockCell);
        Assert.Contains(subBlock.Items, c => c.FormKey == _fixture.ExteriorCell);
    }

    // #597's remaining refusal on this path, named: with the worldspace override no longer refused,
    // what still can't be copied is a cell the destination already holds — FormKeyCollision, before
    // anything is written. (The other standing refusal, a TopCell with no block/sub-block to place,
    // keeps its own two tests in RecordEditServiceContainerCopyTests.)
    [Fact]
    public void CopyExteriorCell_WhenDestinationAlreadyHoldsTheCellItself_RefusesWithFormKeyCollision()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
    }

    /// <summary>Compile the destination and import the resulting binary — every #597 assertion ends
    /// at the wire, per this class's own doc comment.</summary>
    private IFallout4ModGetter ImportCompiled()
    {
        var compileResult = CompileService().Compile(_fixture.DestinationPlugin, new CompileSource.WorkingTree());
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
    public void CopyExteriorTemporaryPlacedReference_CompilesToBinary_InTheTemporarySlot()
    {
        var copyResult = EditService().CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorTemporaryRef.ToString(), _fixture.DestinationPlugin);
        Assert.True(copyResult.Applied, copyResult.Message);

        var compileResult = CompileService().Compile(_fixture.DestinationPlugin, new CompileSource.WorkingTree());
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
