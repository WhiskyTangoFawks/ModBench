using MEditService.LoadOrder;

namespace MEditService.Commands.Edits;

// A FormKey's mod name is a filename, so it compares as one.
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

/// <summary>An item of a selection that wrote, and what the write made of it: a duplicate's
/// FormKey, a compile's diagnostics, <see cref="NoOutcome"/> for a write that makes nothing.</summary>
public sealed record ItemLanded<TItem, TOutcome>(TItem Item, TOutcome Outcome);

/// <summary>The outcome of a write that makes nothing.</summary>
public readonly record struct NoOutcome;

/// <summary>An item of a selection that wrote nothing, with the typed refusal and the message naming
/// the way out.</summary>
public sealed record ItemRefused<TItem, TRefusal>(TItem Item, TRefusal Refusal, string Message);

/// <summary>A cause no item of a selection escapes.</summary>
public sealed record SelectionRefusal<TRefusal>(TRefusal Refusal, string Message);

/// <summary>A gesture over a selection (commands.md, A selection is one gesture): the items that
/// landed, each refused item with its reason, and a cause no item escapes as
/// <see cref="SelectionRefusal"/> (ADR-0019).</summary>
public sealed class SelectionResult<TItem, TRefusal, TOutcome>
{
    private SelectionResult(
        IReadOnlyList<ItemLanded<TItem, TOutcome>> landed, IReadOnlyList<ItemRefused<TItem, TRefusal>> refused,
        SelectionRefusal<TRefusal>? selectionRefusal) =>
        (Landed, Refused, SelectionRefusal) = (landed, refused, selectionRefusal);

    internal static SelectionResult<TItem, TRefusal, TOutcome> PerItem(
        IReadOnlyList<ItemLanded<TItem, TOutcome>> landed, IReadOnlyList<ItemRefused<TItem, TRefusal>> refused) =>
        new(landed, refused, selectionRefusal: null);

    internal static SelectionResult<TItem, TRefusal, TOutcome> WholeSelectionRefused(TRefusal refusal, string message) =>
        new([], [], new SelectionRefusal<TRefusal>(refusal, message));

    public IReadOnlyList<ItemLanded<TItem, TOutcome>> Landed { get; }

    public IReadOnlyList<ItemRefused<TItem, TRefusal>> Refused { get; }

    public SelectionRefusal<TRefusal>? SelectionRefusal { get; }
}
