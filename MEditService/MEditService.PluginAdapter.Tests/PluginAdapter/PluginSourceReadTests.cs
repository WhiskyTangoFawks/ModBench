using System.Text;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Starfield = Mutagen.Bethesda.Starfield;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginSourceReadTests
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static Task<RepositoriesLib.Answer<PluginSource, PluginFailure>> ReadSourceAsync(string pluginPath, GameRelease release)
    {
        var folder = Path.GetDirectoryName(pluginPath) ?? throw new ArgumentException("No folder.", nameof(pluginPath));
        var name = Path.GetFileName(pluginPath);
        return Adapter.ReadSourceOfAsync(
            new RegisteredPlugin(name, "FixtureMod", pluginPath, new PluginProvider.FromMod("FixtureMod", folder), Line: null),
            EmptyLoadOrder.Of(release), new PluginStrings(folder, folder));
    }

    [Fact]
    public async Task ALocalizedPluginWhoseStringsAreInItsArchive_ReadsItsStringsFromThere()
    {
        using var folder = new ScratchDirectory("medit-source-archived-strings-");
        var pluginPath = Path.Combine(folder, "Fixture.esl");
        LocalizedDoorPlugin.Write(pluginPath, "The Big Door");
        LocalizedDoorPlugin.PackStrings(pluginPath, Path.Combine(folder, "Fixture.bsa"));

        var source = (await ReadSourceAsync(pluginPath, GameRelease.SkyrimSE)).Answered();

        Assert.Contains(source.Files, file => Encoding.UTF8.GetString(file.Content).Contains("The Big Door", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ARecordOfThePluginsOwnObjectIdZero_FailsNamingIt_SinceTheHeadersSourceHoldsThatFormKey()
    {
        using var folder = new ScratchDirectory("medit-source-object-id-zero-");
        var pluginPath = Path.Combine(folder, "Fixture.esp");
        var mod = new SkyrimMod(ModKey.FromFileName("Fixture.esp"), SkyrimRelease.SkyrimSE);
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Master.esm") });
        mod.Npcs.AddNew("ZeroGuy");
        ((IModGetter)mod).WriteToBinary(pluginPath, new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
        {
            MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
        });
        var bytes = File.ReadAllBytes(pluginPath);
        const int formIdOffset = 12;
        const uint ownObjectIdZero = 0x01000000;
        BitConverter.GetBytes(ownObjectIdZero).CopyTo(bytes, bytes.AsSpan().LastIndexOf("NPC_"u8) + formIdOffset);
        File.WriteAllBytes(pluginPath, bytes);

        Assert.False((await ReadSourceAsync(pluginPath, GameRelease.SkyrimSE)).Holds(out _, out var failure));
        Assert.Equal(
            "NPC_ 000000:Fixture.esp holds object ID 000000, the FormKey its plugin header's source holds",
            Assert.IsType<PluginFailure.HeaderFormKeyHeld>(failure).Reason);
    }

    [Fact]
    public async Task AStarfieldPluginOfManyCellBlocks_WhosePlacedPropertiesTheFormVersionShapes_Reads()
    {
        using var folder = new ScratchDirectory("medit-source-form-version-");
        var pluginPath = Path.Combine(folder, "Fixture.esm");
        var mod = new Starfield.StarfieldMod(ModKey.FromFileName("Fixture.esm"), Starfield.StarfieldRelease.Starfield);
        mod.Cells.Records.AddRange(Enumerable.Range(0, 10).Select(block => CellBlockOfPlacedProperties(mod, block)));
        ((IModGetter)mod).WriteToBinary(pluginPath);

        Assert.True((await ReadSourceAsync(pluginPath, GameRelease.Starfield)).Holds(out _, out var failure), failure?.Reason);
    }

    private static Starfield.CellBlock CellBlockOfPlacedProperties(Starfield.StarfieldMod mod, int number)
    {
        var block = new Starfield.CellBlock { BlockNumber = number, GroupType = Starfield.GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.AddRange(Enumerable.Range(0, 10).Select(subBlock => CellSubBlockOfPlacedProperties(mod, subBlock)));
        return block;
    }

    private static Starfield.CellSubBlock CellSubBlockOfPlacedProperties(Starfield.StarfieldMod mod, int number)
    {
        var subBlock = new Starfield.CellSubBlock { BlockNumber = number, GroupType = Starfield.GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.AddRange(Enumerable.Range(0, 20).Select(value => new Starfield.Cell(mod)
        {
            Flags = Starfield.Cell.Flag.IsInteriorCell,
            Temporary = { new Starfield.PlacedObject(mod) { Properties = [new Starfield.ObjectProperty { Value = value }] } },
        }));
        return subBlock;
    }
}
