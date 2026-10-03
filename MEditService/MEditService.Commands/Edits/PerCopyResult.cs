using System.Text.Json.Serialization;
using MEditService.LoadOrder;

namespace MEditService.Commands.Edits;

/// <summary>Copy's mode Option (commands.md, Record, `copy`): the record under its own FormKey, or a
/// duplicate under the destination's next free one.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CopyMode
{
    New,
    Override,
}

/// <summary>One record into one destination: the unit a copy lands or is refused by.</summary>
public readonly record struct CopyItem(RecordAt Record, PluginAddress Destination);

/// <summary><see cref="NewFormKey"/> is the duplicate's, and null for an override.</summary>
public sealed record CopyLanded(CopyItem Item, string? NewFormKey);

public sealed record CopyRefused(CopyItem Item, RecordEditRefusal Refusal, string Message);

/// <summary>Copy answers per record and destination (ADR-0019 invariant 4).</summary>
public sealed class PerCopyResult(IReadOnlyList<CopyLanded> applied, IReadOnlyList<CopyRefused> refused)
{
    public IReadOnlyList<CopyLanded> Applied { get; } = applied;

    public IReadOnlyList<CopyRefused> Refused { get; } = refused;

    public bool AllApplied => Refused.Count == 0;
}
