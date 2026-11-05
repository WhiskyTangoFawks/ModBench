using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Game;

/// <summary>What the shared codec source asks each game's project to answer.</summary>
internal static class GameSpecifics
{
    // xEdit offers the light templates in a VR or LE release only with the VRESL dll, which nothing here detects.
    public static IReadOnlyList<IReadOnlyList<HeaderFlag>> NewPluginFlags(GameRelease release, ModType type) =>
        CreatablePluginFlags.Offered(type, release is GameRelease.SkyrimSE or GameRelease.EnderalSE ? [HeaderFlag.Small] : [], flaggedEsp: true);

    public const int BlueprintFlag = 0;

    public static IReadOnlyDictionary<string, int> LoadFlags { get; } = Enum.GetValues<SkyrimModHeader.HeaderFlag>()
        .Where(flag => flag != SkyrimModHeader.HeaderFlag.Localized)
        .ToDictionary(flag => flag.ToString(), flag => (int)flag);

    // Proven over the five masters and every Creation Club plugin: 865 entry-point effects, 276 region
    // RDATs, 240 races. No Skyrim record has a power-grid counter or a weapon template.
    public static CreationKitShapes CreationKitShapes { get; } = new(
        SubrecordSizes: new Dictionary<(string, string), int>
        {
            [("REGN", "RDAT")] = 8, // Type u32, Override u8, Priority u8, unused ×2
            [("PERK", "EPF3")] = 4, // Script Flags u16, Fragment Index u16
        },
        SubrecordCounts: new Dictionary<(string, string), int>
        {
            [("RACE", "NAME")] = 32, // Biped Object Names — one per biped slot
        },
        CountedEntries: new Dictionary<(string, string), string>(),
        TemplateCombinations: new HashSet<string>(),
        EntryPoints: new(
            EpftByFunction: new Dictionary<byte, byte> { [1] = 1, [2] = 1, [3] = 1, [9] = 4, [10] = 5, [11] = 6, [12] = 2, [14] = 2, [15] = 7 },
            FunctionsWithoutParameters: new HashSet<byte> { 7 },
            FunctionsCarryingEpf3: new HashSet<byte> { 9 }));

    public static IReadOnlyList<string> TransientTypes(IGameModGetter _) => [];

    public static bool Normalizes(IMajorRecordGetter _) => false;

    public static void Normalize(IMajorRecord _)
    {
        // Skyrim's rewrite respells nothing beyond the group fields every game shares.
    }
}
