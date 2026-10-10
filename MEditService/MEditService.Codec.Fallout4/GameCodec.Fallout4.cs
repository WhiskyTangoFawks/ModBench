using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Game;

/// <summary>What the shared codec source asks each game's project to answer.</summary>
internal static class GameSpecifics
{
    public static IReadOnlyDictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>> SiblingsInUse { get; } =
        new Dictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>>
        {
            [("IFunctionConditionDataGetter", "Function")] = Fallout4ConditionAnnotations.FunctionParameterSlots,
            [("IConditionDataGetter", "RunOnType")] = Fallout4ConditionAnnotations.RunOnReference,
        };

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
