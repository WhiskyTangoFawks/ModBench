using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Starfield;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginContentFlagsTests
{
    private const int BlueprintBitOfStarfieldsTes4HeaderFlags = 0x800;

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static PluginContent ReadFallout4(string fileName, Action<Fallout4Mod> shape)
    {
        using var scratch = new ScratchDirectory("content-flags-");
        var path = Path.Combine(scratch, fileName);
        var mod = new Fallout4Mod(ModKey.FromFileName(fileName), Fallout4Release.Fallout4);
        shape(mod);
        mod.WriteToBinary(path);
        return Adapter.ReadContent(new ModPath(mod.ModKey, path), EmptyLoadOrder.Of(GameRelease.Fallout4), PluginStrings.None).Answered();
    }

    private static PluginContent ReadStarfield(string fileName, Action<StarfieldMod> shape)
    {
        using var scratch = new ScratchDirectory("content-flags-");
        var path = Path.Combine(scratch, fileName);
        var mod = new StarfieldMod(ModKey.FromFileName(fileName), StarfieldRelease.Starfield);
        shape(mod);
        mod.WriteToBinary(path);
        return Adapter.ReadContent(new ModPath(mod.ModKey, path), EmptyLoadOrder.Of(GameRelease.Starfield), PluginStrings.None).Answered();
    }

    [Theory]
    [InlineData("Plain.esp", false, false)]
    [InlineData("Plain.esm", false, true)]
    [InlineData("Flagged.esp", true, true)]
    public void ReadContent_IsMaster_IsTheHeaderFlagOrAMasterExtension(string fileName, bool flagged, bool expected)
    {
        var content = ReadFallout4(fileName, mod => mod.IsMaster = flagged);

        Assert.Equal(expected, content.IsMaster);
    }

    [Theory]
    [InlineData("Plain.esp", false, false)]
    [InlineData("Plain.esl", false, true)]
    [InlineData("Flagged.esp", true, true)]
    public void ReadContent_IsLight_IsTheHeaderFlagOrTheEslExtension(string fileName, bool flagged, bool expected)
    {
        var content = ReadFallout4(fileName, mod => mod.IsSmallMaster = flagged);

        Assert.Equal(expected, content.IsLight);
    }

    [Fact]
    public void ReadContent_Description_IsTheHeadersDescription()
    {
        var content = ReadFallout4("Described.esp", mod => mod.ModHeader.Description = "Patch v2.0.5");

        Assert.Equal("Patch v2.0.5", content.Description);
    }

    [Fact]
    public void ReadContent_Description_IsDecodedInTheLoadOrdersStringsLanguage()
    {
        const string placeholder = "AAAAAAAAAAAA";
        var cyrillic = System.Text.Encoding.UTF8.GetBytes("\u041f\u0440\u0438\u0432\u0435\u0442");
        using var scratch = new ScratchDirectory("content-description-");
        var path = Path.Combine(scratch, "Described.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Described.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Description = placeholder;
        mod.WriteToBinary(path);
        var bytes = File.ReadAllBytes(path);
        var at = bytes.AsSpan().IndexOf(System.Text.Encoding.ASCII.GetBytes(placeholder));
        cyrillic.CopyTo(bytes, at);
        File.WriteAllBytes(path, bytes);

        string? ReadIn(Language language) =>
            Adapter.ReadContent(new ModPath(mod.ModKey, path), EmptyLoadOrder.Of(GameRelease.Fallout4, language), PluginStrings.None).Answered().Description;

        Assert.Equal("\u041f\u0440\u0438\u0432\u0435\u0442", ReadIn(Language.Russian));
        Assert.NotEqual(ReadIn(Language.Russian), ReadIn(Language.English));
    }

    [Fact]
    public void ReadContent_Description_IsNullForAHeaderWithNone()
    {
        Assert.Null(ReadFallout4("Plain.esp", _ => { }).Description);
    }

    [Fact]
    public void ReadContent_Description_IsReadForStarfieldToo()
    {
        var content = ReadStarfield("Described.esp", mod => mod.ModHeader.Description = "Patch v2.0.5");

        Assert.Equal("Patch v2.0.5", content.Description);
    }

    [Fact]
    public void CountRecords_IsEveryRecordThePluginHolds_ThoseInsideAContainerToo()
    {
        using var scratch = new ScratchDirectory("content-count-");
        var path = Path.Combine(scratch, "Counted.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Counted.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("Npc1");
        mod.Npcs.AddNew("Npc2");
        var cell = new Mutagen.Bethesda.Fallout4.Cell(mod) { EditorID = "Room" };
        cell.Temporary.Add(new Mutagen.Bethesda.Fallout4.PlacedObject(mod) { EditorID = "PlacedInRoom" });
        mod.AddInteriorCells(cell);
        mod.WriteToBinary(path);

        var counted = Adapter.CountRecords(new ModPath(mod.ModKey, path), EmptyLoadOrder.Of(GameRelease.Fallout4)).Answered();

        Assert.Equal((4, null), counted);
    }

    [Fact]
    public void ReadContent_IsMedium_IsFalseForAFormatWithNoMediumPlugins()
    {
        Assert.False(ReadFallout4("Plain.esm", _ => { }).IsMedium);
    }

    [Theory]
    [InlineData("Mid.esm", true, true)]
    [InlineData("Full.esm", false, false)]
    [InlineData("Mid.esl", true, false)]
    public void ReadContent_IsMedium_IsTheMediumFlag_AndNeverOnAnEslNamedPlugin(string fileName, bool medium, bool expected)
    {
        var content = ReadStarfield(fileName, mod =>
        {
            mod.IsMediumMaster = medium;
        });

        Assert.Equal(expected, content.IsMedium);
    }

    [Theory]
    [InlineData(true, BlueprintBitOfStarfieldsTes4HeaderFlags, "Ships.esp", true)]
    [InlineData(false, BlueprintBitOfStarfieldsTes4HeaderFlags, "Ships.esm", true)]
    [InlineData(false, BlueprintBitOfStarfieldsTes4HeaderFlags, "Ships.esl", true)]
    [InlineData(false, BlueprintBitOfStarfieldsTes4HeaderFlags, "Ships.esp", false)]
    [InlineData(true, 0, "Ships.esm", false)]
    public void ReadContent_IsBlueprint_FollowsMo2sPluginListRule_BlueprintBitOnAMasterFlaggedOrEsmOrEslNamedPlugin(
        bool masterFlagged, int headerFlags, string fileName, bool expected)
    {
        var content = ReadStarfield(fileName, mod =>
        {
            mod.IsMaster = masterFlagged;
            mod.ModHeader.Flags |= (StarfieldModHeader.HeaderFlag)headerFlags;
        });

        Assert.Equal(expected, content.IsBlueprint);
    }

    [Fact]
    public void ReadContent_IsBlueprint_IsFalseForAGameWithNoBlueprintPlugins()
    {
        var content = ReadFallout4("Ships.esm", mod => mod.ModHeader.Flags |= (Fallout4ModHeader.HeaderFlag)BlueprintBitOfStarfieldsTes4HeaderFlags);

        Assert.False(content.IsBlueprint);
    }
}
