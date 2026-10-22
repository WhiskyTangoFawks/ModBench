using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Game;

/// <summary>What the shared codec source asks each game's project to answer.</summary>
internal static class GameSpecifics
{
    public const int BlueprintFlag = 0;

    // Proven over every shipped binary: all 823 entry-point effects, all 1,031 weapon templates.
    public static CreationKitShapes CreationKitShapes { get; } = new(
        SubrecordSizes: new Dictionary<(string, string), int>
        {
            [("REGN", "RDAT")] = 8, // Type u32, Override u8, Priority u8, unused ×2
            [("PERK", "EPF3")] = 2, // Script Flags u16
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

    public static bool Normalizes(IMajorRecordGetter record) =>
        record is IQuestGetter || FunctionConditions.CanReach(record.GetType());

    public static void Normalize(IMajorRecord copy)
    {
        FunctionConditions.ForEach(copy, node =>
        {
            if (node is FunctionConditionData data) KeepTheWrittenParameterViews(data);
        });
        if (copy is not Quest quest) return;
        quest.Timestamp = 0;
        quest.Unknown = 0;
        foreach (var topic in quest.DialogTopics) GameCodec.ZeroTopicGroupFields(topic);
    }

    private static readonly RecordGraph FunctionConditions = new(type => type == typeof(ConditionData) || type == typeof(FunctionConditionData));

    // Each parameter is four bytes Mutagen reads as both a number and a record. It writes the view the
    // function reads, and its reread derives the other from the master list, which a compile prunes
    // (ADR-0008).
    private static void KeepTheWrittenParameterViews(FunctionConditionData data)
    {
        var (one, two, _) = Condition.GetParameterTypes(data.Function);
        if (one.GetCategory() == Condition.ParameterCategory.Form) data.ParameterOneNumber = 0;
        else data.ParameterOneRecord.SetToNull();
        if (two.GetCategory() == Condition.ParameterCategory.Form) data.ParameterTwoNumber = 0;
        else data.ParameterTwoRecord.SetToNull();
    }
}
