using MEditService.LoadOrder;

namespace MEditService.Commands.Edits;

/// <summary>A record and the plugin holding it, named by filename and origin (ADR-0012 invariant 1):
/// one filename can be in two mods, each holding the record.</summary>
public readonly record struct RecordAt(PluginCopyKey Plugin, string FormKey);

/// <summary>A record of a selection that wrote nothing, with the typed refusal and the message
/// naming the way out.</summary>
public sealed record RecordRefused(RecordAt Record, RecordEditRefusal Refusal, string Message);

/// <summary>A gesture over several records answers per record: each one applied or refused on its
/// own, never the whole batch for one (ADR-0019 invariant 4).</summary>
public sealed record PerRecordResult(IReadOnlyList<RecordAt> Applied, IReadOnlyList<RecordRefused> Refused)
{
    public bool AllApplied => Refused.Count == 0;
}
