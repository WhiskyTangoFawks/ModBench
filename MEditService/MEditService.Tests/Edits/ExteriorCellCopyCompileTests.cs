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

    public void Dispose() => _fixture.Dispose();

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
