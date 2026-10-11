using System.Text;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;

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
        var mod = new Mutagen.Bethesda.Starfield.StarfieldMod(ModKey.FromFileName("Fixture.esm"), Mutagen.Bethesda.Starfield.StarfieldRelease.Starfield);
        for (var b = 0; b < 10; b++)
        {
            var block = new Mutagen.Bethesda.Starfield.CellBlock { BlockNumber = b, GroupType = Mutagen.Bethesda.Starfield.GroupTypeEnum.InteriorCellBlock };
            for (var s = 0; s < 10; s++)
            {
                var subBlock = new Mutagen.Bethesda.Starfield.CellSubBlock { BlockNumber = s, GroupType = Mutagen.Bethesda.Starfield.GroupTypeEnum.InteriorCellSubBlock };
                for (var c = 0; c < 20; c++)
                {
                    var cell = new Mutagen.Bethesda.Starfield.Cell(mod) { Flags = Mutagen.Bethesda.Starfield.Cell.Flag.IsInteriorCell };
                    cell.Temporary.Add(new Mutagen.Bethesda.Starfield.PlacedObject(mod) { Properties = [new Mutagen.Bethesda.Starfield.ObjectProperty { Value = c }] });
                    subBlock.Cells.Add(cell);
                }
                block.SubBlocks.Add(subBlock);
            }
            mod.Cells.Records.Add(block);
        }
        ((IModGetter)mod).WriteToBinary(pluginPath);

        Assert.True((await ReadSourceAsync(pluginPath, GameRelease.Starfield)).Holds(out _, out var failure), failure?.Reason);
    }
}
