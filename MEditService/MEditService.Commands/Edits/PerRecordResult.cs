using MEditService.LoadOrder;

namespace MEditService.Commands.Edits;

/// <summary>A record and the plugin holding it, named by filename and origin (ADR-0012 invariant 1):
/// one filename can be in two mods, each holding the record.</summary>
public readonly record struct RecordAt(PluginCopyKey Plugin, string FormKey);

/// <summary>A record of a selection that wrote nothing, with the typed refusal and the message
/// naming the way out.</summary>
public sealed record RecordRefused(RecordAt Record, RecordEditRefusal Refusal, string Message);

/// <summary>A gesture over several records answers per record, never the whole batch for one
/// (ADR-0019 invariant 4), except for a cause no record escapes: <see cref="SelectionRefusal"/> names
/// it, and no record was written.</summary>
public sealed record PerRecordResult(
    IReadOnlyList<RecordAt> Applied, IReadOnlyList<RecordRefused> Refused, RecordEditResult? SelectionRefusal = null)
{
    public static PerRecordResult WholeSelectionRefused(RecordEditRefusal refusal, string message) =>
        new([], [], RecordEditResult.Refused(refusal, message));

    public bool AllApplied => Refused.Count == 0 && SelectionRefusal is null;
}
