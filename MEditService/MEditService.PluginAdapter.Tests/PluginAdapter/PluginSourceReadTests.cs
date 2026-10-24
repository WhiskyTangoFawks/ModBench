using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
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
            new RegisteredPlugin(name, "FixtureMod", pluginPath, new PluginProvider.FromMod("FixtureMod", folder, folder), Line: null, HandedStrings.Of(pluginPath)),
            EmptyLoadOrder.Of(release));
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

    public static TheoryData<string, uint, Type, string> RecordsOfAFormIdNoSourceCanHold => new()
    {
        {
            "the plugin's own object ID 000000, the FormKey the header's source holds", 0x01000000, typeof(PluginFailure.HeaderFormKeyHeld),
            "NPC_ 000000:Fixture.esp holds object ID 000000, the FormKey its plugin header's source holds"
        },
        { "FormID 00000000, the null FormID", 0, typeof(PluginFailure.NullFormIdHeld), "NPC_ 00000000 holds the null FormID, so the plugin is malformed" },
    };

    [Theory]
    [MemberData(nameof(RecordsOfAFormIdNoSourceCanHold))]
    public async Task ARecordOfAFormIdNoSourceCanHold_FailsNamingIt(string _, uint formId, Type failureType, string reason)
    {
        using var folder = new ScratchDirectory("medit-source-formid-");

        Assert.False((await ReadSourceAsync(PluginWithAnNpcOfFormId(folder, formId), GameRelease.Fallout4)).Holds(out var _, out var failure));
        Assert.IsType(failureType, failure);
        Assert.Equal(reason, failure.Reason);
    }

    [Fact]
    public async Task TheSourceTree_HoldsNoCarriageReturn_WhateverNewlineTheOperatingSystemWrites()
    {
        using var folder = new ScratchDirectory("medit-source-newlines-");
        var pluginPath = Path.Combine(folder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("Npc");
        mod.WriteToBinary(pluginPath);

        var source = (await ReadSourceAsync(pluginPath, GameRelease.Fallout4)).Answered();

        Assert.NotEmpty(source.Files);
        Assert.All(source.Files, file => Assert.DoesNotContain((byte)'\r', file.Content));
    }

    private static string PluginWithAnNpcOfFormId(string folder, uint formId)
    {
        var pluginPath = Path.Combine(folder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Master.esm") });
        mod.Npcs.AddNew("Npc");
        ((IModGetter)mod).WriteToBinary(pluginPath, new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
        {
            MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
        });
        var bytes = File.ReadAllBytes(pluginPath);
        const int formIdOffset = 12;
        BitConverter.GetBytes(formId).CopyTo(bytes, bytes.AsSpan().LastIndexOf("NPC_"u8) + formIdOffset);
        File.WriteAllBytes(pluginPath, bytes);
        return pluginPath;
    }

    [Fact]
    public async Task AStarfieldPluginOfManyCellBlocks_ReadsEachPlacedPropertyUnderItsOwnRecordsFormVersion()
    {
        using var folder = new ScratchDirectory("medit-source-form-version-");
        var pluginPath = Path.Combine(folder, "Fixture.esm");
        var mod = new Starfield.StarfieldMod(ModKey.FromFileName("Fixture.esm"), Starfield.StarfieldRelease.Starfield);
        mod.Cells.Records.AddRange(Enumerable.Range(0, BlockCount).Select(block => CellBlockOfPlacedProperties(mod, block)));
        ((IModGetter)mod).WriteToBinary(pluginPath);

        var source = (await ReadSourceAsync(pluginPath, GameRelease.Starfield)).Answered();

        var written = Enumerable.Range(0, BlockCount * SubBlockCount)
            .SelectMany(_ => Enumerable.Range(0, CellCount).Select(value => ValuesText(PropertiesOf(value).Select(property => property.Value))));
        Assert.Equal(written.Order(), source.Files.Select(PlacedPropertyValues).OfType<string>().Order());
    }

    private const int BlockCount = 10;
    private const int SubBlockCount = 10;
    private const int CellCount = 20;
    private const int ThreeEightByteProperties = 3;
    private const int TwoTwelveByteProperties = 2;

    private static string? PlacedPropertyValues(TreeFile file) =>
        JsonNode.Parse(file.Content)?["Temporary"]?[0]?["Properties"] is JsonArray properties
            ? ValuesText(properties.Select(property => property.Require()["Value"].Require().GetValue<float>()))
            : null;

    private static string ValuesText(IEnumerable<float> values) => string.Join(", ", values.Select(value => value.ToString(CultureInfo.InvariantCulture)));

    private static Starfield.CellBlock CellBlockOfPlacedProperties(Starfield.StarfieldMod mod, int number)
    {
        var block = new Starfield.CellBlock { BlockNumber = number, GroupType = Starfield.GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.AddRange(Enumerable.Range(0, SubBlockCount).Select(subBlock => CellSubBlockOfPlacedProperties(mod, subBlock)));
        return block;
    }

    private static Starfield.CellSubBlock CellSubBlockOfPlacedProperties(Starfield.StarfieldMod mod, int number)
    {
        var subBlock = new Starfield.CellSubBlock { BlockNumber = number, GroupType = Starfield.GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.AddRange(Enumerable.Range(0, CellCount).Select(value => new Starfield.Cell(mod)
        {
            Flags = Starfield.Cell.Flag.IsInteriorCell,
            Temporary = { PlacedWhosePropertiesFillOneLengthAtEitherFormVersion(mod, value) },
        }));
        return subBlock;
    }

    private static Starfield.PlacedObject PlacedWhosePropertiesFillOneLengthAtEitherFormVersion(Starfield.StarfieldMod mod, int value) =>
        value % 2 == 0
            ? new Starfield.PlacedObject(mod) { FormVersion = 151, Properties = [.. PropertiesOf(value)] }
            : new Starfield.PlacedObject(mod) { Properties = [.. PropertiesOf(value)] };

    private static IEnumerable<Starfield.ObjectProperty> PropertiesOf(int value) =>
        Enumerable.Range(0, value % 2 == 0 ? ThreeEightByteProperties : TwoTwelveByteProperties).Select(index => new Starfield.ObjectProperty { Value = value + (index + 1) / 4f });
}
