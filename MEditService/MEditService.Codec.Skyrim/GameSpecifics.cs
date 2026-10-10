using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Game;

/// <summary>What the shared codec source asks each game's project to answer.</summary>
internal static class GameSpecifics
{
    public static SiblingsInUseRows SiblingsInUse => SiblingsInUseRows.None;

    public static IReadOnlyList<string> TransientTypes(IGameModGetter _) => [];

    public static IMajorRecordGetter NormalizeRecord(IMajorRecordGetter record) => record;
}
