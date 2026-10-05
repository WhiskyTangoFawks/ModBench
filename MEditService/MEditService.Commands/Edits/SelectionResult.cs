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

/// <summary><see cref="NewFormKey"/> is the duplicate's, and null for every write that makes none.</summary>
public sealed record ItemLanded<TItem>(TItem Item, string? NewFormKey);

/// <summary>An item of a selection that wrote nothing, with the typed refusal and the message naming
/// the way out.</summary>
public sealed record ItemRefused<TItem>(TItem Item, RecordEditRefusal Refusal, string Message);

/// <summary>A gesture over a selection (commands.md, A selection is one gesture): the items that
/// landed, each refused item with its reason, and a cause no item escapes as
/// <see cref="SelectionRefusal"/> (ADR-0019).</summary>
public sealed class SelectionResult<TItem>
{
    private SelectionResult(
        IReadOnlyList<ItemLanded<TItem>> landed, IReadOnlyList<ItemRefused<TItem>> refused, RecordEditResult? selectionRefusal) =>
        (Landed, Refused, SelectionRefusal) = (landed, refused, selectionRefusal);

    internal static SelectionResult<TItem> PerItem(
        IReadOnlyList<ItemLanded<TItem>> landed, IReadOnlyList<ItemRefused<TItem>> refused) =>
        new(landed, refused, selectionRefusal: null);

    internal static SelectionResult<TItem> WholeSelectionRefused(RecordEditRefusal refusal, string message) =>
        new([], [], RecordEditResult.Refused(refusal, message));

    public IReadOnlyList<ItemLanded<TItem>> Landed { get; }

    public IReadOnlyList<ItemRefused<TItem>> Refused { get; }

    public RecordEditResult? SelectionRefusal { get; }

    public bool AllApplied => Refused.Count == 0 && SelectionRefusal is null;
}
