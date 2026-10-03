using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginFlagPredicatesTests
{
    private const int BlueprintBitOfStarfieldsTes4HeaderFlags = 0x800;

    [Theory]
    [InlineData(GameRelease.Starfield, true)]
    [InlineData(GameRelease.Fallout4, false)]
    [InlineData(GameRelease.SkyrimSE, false)]
    public void HasBlueprintPlugins_OnlyForStarfield(GameRelease release, bool expected) =>
        Assert.Equal(expected, PluginFlagPredicates.HasBlueprintPlugins(release));

    [Theory]
    [InlineData(true, BlueprintBitOfStarfieldsTes4HeaderFlags, "Ships.esp", true)]
    [InlineData(false, BlueprintBitOfStarfieldsTes4HeaderFlags, "Ships.esm", true)]
    [InlineData(false, BlueprintBitOfStarfieldsTes4HeaderFlags, "Ships.esl", true)]
    [InlineData(false, BlueprintBitOfStarfieldsTes4HeaderFlags, "Ships.esp", false)]
    [InlineData(true, 0, "Ships.esm", false)]
    public void IsBlueprint_FollowsMo2sPluginListRule_BlueprintBitOnAMasterFlaggedOrEsmOrEslNamedPlugin(bool masterFlagged, int headerFlags, string fileName, bool expected)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(fileName), Fallout4Release.Fallout4);
        if (masterFlagged) mod.ModHeader.Flags |= Fallout4ModHeader.HeaderFlag.Master;

        Assert.Equal(expected, PluginFlagPredicates.IsBlueprint(mod, fileName, headerFlags));
    }

    private sealed record Flags(bool CanBeMedium, bool Medium, bool Small, string Name) : IModFlagsGetter
    {
        public ModKey ModKey => ModKey.FromFileName(Name);
        public MasterStyle MasterStyle => Medium ? MasterStyle.Medium : MasterStyle.Full;
        public bool CanUseLocalization => false;
        public bool UsingLocalization => false;
        public bool CanBeSmallMaster => true;
        public bool IsSmallMaster => Small;
        public bool CanBeMediumMaster => CanBeMedium;
        public bool IsMediumMaster => Medium;
        public bool IsMaster => false;
        public bool ListsOverriddenForms => false;
    }

    [Theory]
    [InlineData(true, true, false, "Mid.esm", true)]
    [InlineData(true, false, false, "Full.esm", false)]
    [InlineData(true, true, true, "Both.esm", false)]
    [InlineData(true, true, false, "Mid.esl", false)]
    [InlineData(false, true, false, "NoMedium.esm", false)]
    public void IsMedium_IsTheMediumFlagWhereTheFormatHasOne_AndNeverBesideLight(
        bool canBeMedium, bool medium, bool small, string fileName, bool expected) =>
        Assert.Equal(expected, PluginFlagPredicates.IsMedium(new Flags(canBeMedium, medium, small, fileName), fileName));

    [Fact]
    public void IsMedium_IsFalseForAFormatWithNoMediumPlugins()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Plain.esm"), Fallout4Release.Fallout4);

        Assert.False(PluginFlagPredicates.IsMedium(mod, "Plain.esm"));
    }
}
