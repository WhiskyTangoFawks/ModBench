using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Starfield;

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
        return Adapter.ReadContent(new ModPath(mod.ModKey, path), GameRelease.Fallout4).Content;
    }

    private static PluginContent ReadStarfield(string fileName, Action<StarfieldMod> shape)
    {
        using var scratch = new ScratchDirectory("content-flags-");
        var path = Path.Combine(scratch, fileName);
        var mod = new StarfieldMod(ModKey.FromFileName(fileName), StarfieldRelease.Starfield);
        shape(mod);
        mod.WriteToBinary(path);
        return Adapter.ReadContent(new ModPath(mod.ModKey, path), GameRelease.Starfield).Content;
    }

    [Theory]
    [InlineData("Plain.esp", false, false)]
    [InlineData("Plain.esm", false, true)]
    [InlineData("Flagged.esp", true, true)]
    public void ReadContent_IsMaster_IsTheHeaderFlagOrTheEsmExtension(string fileName, bool flagged, bool expected)
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
