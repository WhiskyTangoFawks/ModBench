using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Game;

/// <summary>What the shared codec source asks each game's project to answer.</summary>
internal static class GameSpecifics
{
    public static SiblingsInUseRows SiblingsInUse { get; } = new(new Dictionary<(string, string), IReadOnlyDictionary<string, IReadOnlyList<string>>>
    {
        [("IFunctionConditionDataGetter", "Function")] = Fallout4ConditionAnnotations.FunctionParameterSlots,
        [("IConditionDataGetter", "RunOnType")] = RunOnAnnotations.Reference,
    });

    // Proven over every shipped binary: all 823 entry-point effects, all 1,031 weapon templates.
    public static CreationKitShapes CreationKitShapes { get; } = new(
        SubrecordSizes: new Dictionary<(string, string), int>
        {
            [("REGN", "RDAT")] = 8, // Type u32, Override u8, Priority u8, unused ×2
        },
        SubrecordCounts: new Dictionary<(string, string), int>
        {
            [("RACE", "NAME")] = 32, // Biped Object Names — one per biped slot
        },
        CountedEntries: new Dictionary<(string, string), string>
        {
            [("REFR", "XWPG")] = "XWPN", // power-grid connections
        },
        TemplateCombinations: new HashSet<string> { "WEAP" },
        EntryPoints: new(
            EpftByFunction: new Dictionary<byte, byte> { [1] = 1, [2] = 1, [3] = 1, [5] = 8, [9] = 4, [10] = 5, [12] = 8, [13] = 8, [14] = 8 },
            FunctionsWithoutParameters: new HashSet<byte> { 6 },
            FunctionsCarryingEpf3: new HashSet<byte> { 9 }));

    public static IReadOnlyList<string> TransientTypes(IGameModGetter plugin) =>
    [
        .. plugin.ModHeader.TransientTypes.Select(
            type => $"{type.FormType}:{string.Join(",", type.Links.Select(link => link.FormKey))}"),
    ];

    public static IMajorRecordGetter NormalizeRecord(IMajorRecordGetter record)
    {
        if (record is not IQuestGetter quest) return record;
        var copy = quest.DeepCopy();
        copy.Timestamp = 0;
        copy.Unknown = 0;
        foreach (var topic in copy.DialogTopics) GameCodec.ZeroTopicGroupFields(topic);
        return copy;
    }
}
