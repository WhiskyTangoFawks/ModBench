using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Game;

/// <summary>What the shared codec source asks each game's project to answer.</summary>
internal static class GameSpecifics
{
    public static SiblingsInUseRows SiblingsInUse { get; } = new()
    {
        [("IFunctionConditionDataGetter", "Function")] = Fallout4ConditionAnnotations.FunctionParameterSlots,
        [("IConditionDataGetter", "RunOnType")] = Fallout4ConditionAnnotations.RunOnReference,
    };

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
