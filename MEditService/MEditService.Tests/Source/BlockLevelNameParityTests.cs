using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog.WorkEngine;

namespace MEditService.Tests.Source;

/// <summary>Track writes a block level's directory through the whole-mod serializer and the spatial
/// mint places one from the repository's own spelling; a tree the two spell differently holds two
/// directories for one block.</summary>
public sealed class BlockLevelNameParityTests
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string Plugin = "Destination.esp";
    private const string WorldspaceFormKey = "000801:Source.esm";
    private const string CellFormKey = "000802:Source.esm";
    private const short BlockX = 3;
    private const short BlockY = -2;
    private const short SubX = 0;
    private const short SubY = -1;

    [Fact]
    public async Task TheDirectoriesTheWholeModSerializerWrites_AreNamedAsTheRepositoryPlacesThem()
    {
        var scratch = Directory.CreateTempSubdirectory("medit-block-name-parity-").FullName;
        try
        {
            await RecordTextCodecGeneratorSeed.SerializeWholeMod(
                OneExteriorCell(), scratch, InlineWorkDropoff.Instance, CancellationToken.None);

            var writtenWorldspace = Directory.EnumerateDirectories(Path.Combine(scratch, "Worldspaces")).Single();
            var writtenBlock = Directory.EnumerateDirectories(writtenWorldspace).Single();
            var writtenSubBlock = Directory.EnumerateDirectories(writtenBlock).Single();
            var writtenCell = Directory.EnumerateDirectories(writtenSubBlock).Single();

            var placed = SourceRepository.ExteriorCellSubtreeFor(
                Plugin, "wrld", WorldspaceFormKey, worldspaceEditorId: null, CellFormKey, cellEditorId: null,
                new CellPlacement(WorldspaceFormKey, BlockX, BlockY, SubX, SubY, IsInterior: false), Release);

            Assert.Equal(Path.GetFileName(writtenWorldspace), Path.GetFileName(placed.WorldspaceDirectory));
            Assert.Equal(Path.GetFileName(writtenBlock), DirectoryOf(placed.BlockGroupDocument));
            Assert.Equal(Path.GetFileName(writtenSubBlock), DirectoryOf(placed.SubBlockGroupDocument));
            Assert.Equal(Path.GetFileName(writtenCell), DirectoryOf(placed.CellDocument));
        }
        finally
        {
            Directory.Delete(scratch, recursive: true);
        }
    }

    private static string DirectoryOf(SourcePlacement placement) =>
        Path.GetFileName(Path.GetDirectoryName(placement.RelativePath)!);

    private static Fallout4Mod OneExteriorCell()
    {
        var subBlock = new WorldspaceSubBlock { BlockNumberX = SubX, BlockNumberY = SubY };
        subBlock.Items.Add(new Cell(FormKey.Factory(CellFormKey), Fallout4Release.Fallout4));

        var block = new WorldspaceBlock { BlockNumberX = BlockX, BlockNumberY = BlockY };
        block.Items.Add(subBlock);

        var worldspace = new Worldspace(FormKey.Factory(WorldspaceFormKey), Fallout4Release.Fallout4);
        worldspace.SubCells.Add(block);

        var mod = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        mod.Worldspaces.Add(worldspace);
        return mod;
    }
}
