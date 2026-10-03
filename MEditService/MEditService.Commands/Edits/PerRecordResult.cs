using MEditService.LoadOrder;

namespace MEditService.Commands.Edits;

/// <summary>A record and the plugin holding it (ADR-0012).</summary>
public readonly record struct RecordAt(PluginAddress Plugin, string FormKey);

// The plugin compares as every other lookup on it does, and a FormKey's mod name is a filename.
internal sealed class SameRecord : IEqualityComparer<RecordAt>
{
    internal static readonly SameRecord Instance = new();

    public bool Equals(RecordAt x, RecordAt y) =>
        PluginAddress.Comparer.Equals(x.Plugin, y.Plugin)
        && string.Equals(x.FormKey, y.FormKey, StringComparison.OrdinalIgnoreCase);

    public int GetHashCode(RecordAt record) => HashCode.Combine(
        PluginAddress.Comparer.GetHashCode(record.Plugin),
        StringComparer.OrdinalIgnoreCase.GetHashCode(record.FormKey));
}

/// <summary>A record of a selection that wrote nothing, with the typed refusal and the message
/// naming the way out.</summary>
public sealed record RecordRefused(RecordAt Record, RecordEditRefusal Refusal, string Message);

/// <summary>A gesture over several records (commands.md, A selection is one gesture): a cause no
/// record escapes is <see cref="SelectionRefusal"/>.</summary>
public sealed class PerRecordResult
{
    private PerRecordResult(
        IReadOnlyList<RecordAt> applied, IReadOnlyList<RecordRefused> refused, RecordEditResult? selectionRefusal) =>
        (Applied, Refused, SelectionRefusal) = (applied, refused, selectionRefusal);

    public static PerRecordResult PerRecord(IReadOnlyList<RecordAt> applied, IReadOnlyList<RecordRefused> refused) =>
        new(applied, refused, selectionRefusal: null);

    public static PerRecordResult WholeSelectionRefused(RecordEditRefusal refusal, string message) =>
        new([], [], RecordEditResult.Refused(refusal, message));

    public IReadOnlyList<RecordAt> Applied { get; }

    public IReadOnlyList<RecordRefused> Refused { get; }

    public RecordEditResult? SelectionRefusal { get; }

    public bool AllApplied => Refused.Count == 0 && SelectionRefusal is null;
}
