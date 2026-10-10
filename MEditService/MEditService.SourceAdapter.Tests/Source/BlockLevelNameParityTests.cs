using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog.WorkEngine;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class BlockLevelNameParityTests
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string Plugin = "Destination.esp";
    private const string WorldspaceFormKey = "000801:Source.esm";
    private const string CellFormKey = "000802:Source.esm";
    private const short BlockX = 0;
    private const short BlockY = -1;
    private const short SubX = 1;
    private const short SubY = -2;
    private const string GridOfThatSubBlock = "9, -9";

    [Fact]
    public async Task TheDirectoriesTheWholeModSerializerWrites_AreNamedAsAPutPlacesThem()
    {
        using var scratch = new ScratchDirectory("medit-block-name-parity-");
        await RecordTextCodecGeneratorSeed.SerializeWholeMod(
            OneExteriorCell(), scratch, InlineWorkDropoff.Instance, CancellationToken.None);

        var writtenWorldspace = Directory.EnumerateDirectories(Path.Combine(scratch, "Worldspaces")).Single();
        var writtenBlock = Directory.EnumerateDirectories(writtenWorldspace).Single();
        var writtenSubBlock = Directory.EnumerateDirectories(writtenBlock).Single();
        var writtenCell = Directory.EnumerateDirectories(writtenSubBlock).Single();

        var placedWorldspace = WorldspaceDirectoryAPutOfOneExteriorCellLeaves(scratch);
        var placedBlock = Directory.EnumerateDirectories(placedWorldspace).Single();
        var placedSubBlock = Directory.EnumerateDirectories(placedBlock).Single();
        var placedCell = Directory.EnumerateDirectories(placedSubBlock).Single();

        Assert.Equal(Path.GetFileName(writtenWorldspace), Path.GetFileName(placedWorldspace));
        Assert.Equal(Path.GetFileName(writtenBlock), Path.GetFileName(placedBlock));
        Assert.Equal(Path.GetFileName(writtenSubBlock), Path.GetFileName(placedSubBlock));
        Assert.Equal(Path.GetFileName(writtenCell), Path.GetFileName(placedCell));
    }

    private static string WorldspaceDirectoryAPutOfOneExteriorCellLeaves(string scratch)
    {
        var modFolder = Directory.CreateDirectory(Path.Combine(scratch, "put")).FullName;
        var key = new PluginAddress(Plugin, TestMod.Name);
        var repository = TestAdapters.Source().OverFolder(TestMod.In(modFolder), Release);

        repository.Put(key, new SourceDocument(WorldspaceFormKey, "wrld", null, Body(WorldspaceFormKey))).Wrote();
        repository.PutInWorldspace(
            key,
            new SourceDocument(CellFormKey, "cell", null, GridBody(CellFormKey)),
            WorldspaceFormKey);

        return Directory
            .EnumerateDirectories(Path.Combine(PluginSourceRoot.In(modFolder, Plugin), "Worldspaces"))
            .Single();
    }

    private static string Body(string formKey) => $"{{\n  \"FormKey\": \"{formKey}\"\n}}";

    private static string GridBody(string formKey) =>
        $"{{\n  \"FormKey\": \"{formKey}\",\n  \"Grid\": {{\n    \"Point\": \"{GridOfThatSubBlock}\"\n  }}\n}}";

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
