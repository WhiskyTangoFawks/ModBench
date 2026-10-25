using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class FormIdLimitTests
{
    private static readonly ModKey Plugin = ModKey.FromFileName("Light.esl");
    private static readonly ModKey Master = ModKey.FromFileName("Master.esm");
    private static readonly FormIdLimit Light = new("light", 0x800, 0xFFF, ByFlag: true, ByExtension: false);

    public static TheoryData<string, Fallout4ModHeader.HeaderFlag, FormIdLimit?> LightLimits => new()
    {
        { "NamedEsl.esl", 0, new FormIdLimit("light", 0x0, 0xFFF, ByFlag: false, ByExtension: true) },
        { "Flagged.esp", Fallout4ModHeader.HeaderFlag.Small, new FormIdLimit("light", 0x0, 0xFFF, ByFlag: true, ByExtension: false) },
        { "FlaggedAndNamedEsl.esl", Fallout4ModHeader.HeaderFlag.Small, new FormIdLimit("light", 0x0, 0xFFF, ByFlag: true, ByExtension: true) },
        { "Neither.esp", 0, null },
    };

    [Theory]
    [MemberData(nameof(LightLimits))]
    public void APluginsLightLimit_IsSetByItsFlag_OrByItsEslName(string fileName, Fallout4ModHeader.HeaderFlag flags, FormIdLimit? limit)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(fileName), Fallout4Release.Fallout4);
        mod.ModHeader.Flags = flags;

        Assert.Equal(limit, PluginFlags.LimitOf(mod, fileName));
    }

    [Fact]
    public void OnlyTheNativeFormKeysOutsideTheRange_AreOutside()
    {
        FormKey[] keys =
        [
            new(Plugin, 0x800),
            new(Plugin, 0xFFF),
            new(Plugin, 0x7FF),
            new(Plugin, 0x1000),
            new(Master, 0x1),
        ];

        Assert.Equal([new FormKey(Plugin, 0x7FF), new FormKey(Plugin, 0x1000)], Light.Outside(Plugin, keys));
    }

    [Theory]
    [InlineData(
        "light", 0x0u, 0xFFFu, false, 1,
        "Light.esl is a light plugin but holds native FormID(s) outside the light range (0x0-0xFFF): 001000:Light.esl. " +
        "Clear the light flag, or change the records' FormIDs.")]
    [InlineData(
        "light", 0x0u, 0xFFFu, true, 1,
        "Light.esl is a light plugin but holds native FormID(s) outside the light range (0x0-0xFFF): 001000:Light.esl. " +
        "Clear the light flag, rename the plugin off .esl, or change the records' FormIDs.")]
    [InlineData(
        "medium", 0x0u, 0xFFFFu, false, 1,
        "Light.esl is a medium plugin but holds native FormID(s) outside the medium range (0x0-0xFFFF): 001000:Light.esl. " +
        "Clear the medium flag, or change the records' FormIDs.")]
    [InlineData(
        "light", 0x0u, 0xFFFu, false, 6,
        "Light.esl is a light plugin but holds native FormID(s) outside the light range (0x0-0xFFF): " +
        "001000:Light.esl, 001001:Light.esl, 001002:Light.esl, 001003:Light.esl and 2 more. " +
        "Clear the light flag, or change the records' FormIDs.")]
    public void CompilesRefusal_NamesTheFlagItsRangeTheFirstFourRecordsOutsideIt_AndEveryRemedy(
        string flag, uint min, uint max, bool byExtension, int outside, string refusal)
    {
        var limit = new FormIdLimit(flag, min, max, ByFlag: !byExtension, ByExtension: byExtension);
        FormKey[] keys = [.. Enumerable.Range(0, outside).Select(i => new FormKey(Plugin, (uint)(0x1000 + i)))];

        Assert.Equal(refusal, limit.Refusal(Plugin.FileName, keys));
    }
}
