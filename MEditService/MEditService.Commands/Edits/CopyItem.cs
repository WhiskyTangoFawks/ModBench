using System.Text.Json.Serialization;
using MEditService.LoadOrder;

namespace MEditService.Commands.Edits;

/// <summary>Copy's mode Option (commands.md, Record, `copy`): the record under its own FormKey, or a
/// duplicate under the destination's next free one, or the record with all its child records under its own FormKey.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CopyMode
{
    New,
    Override,
    DeepOverride,
}

/// <summary>One record into one destination: the unit a copy lands or is refused by.</summary>
public readonly record struct CopyItem(RecordAt Record, PluginAddress Destination);

internal sealed class SameCopy : IEqualityComparer<CopyItem>
{
    internal static readonly SameCopy Instance = new();

    public bool Equals(CopyItem x, CopyItem y) =>
        SameRecord.Instance.Equals(x.Record, y.Record) && PluginAddress.Comparer.Equals(x.Destination, y.Destination);

    public int GetHashCode(CopyItem item) =>
        HashCode.Combine(SameRecord.Instance.GetHashCode(item.Record), PluginAddress.Comparer.GetHashCode(item.Destination));
}
