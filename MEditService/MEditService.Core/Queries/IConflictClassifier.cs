using MEditService.Core.Records;

namespace MEditService.Core.Queries;

public interface IConflictClassifier
{
    // resolveFormKey: ADR-0031's O(1) lookup (IRecordReads.Resolve), batched once per
    // Classify call so every formKey-typed FieldDiff leaf's Resolutions is populated in this same
    // pass rather than round-tripped per value. Null when the caller has no resolver available
    // (existing behavior — no Resolutions populated).
    //
    // pluginParticipates (#267 / ADR-0035): the plugins.txt `*` prefix, keyed by ColumnKey.Of(
    // plugin, origin) since #34 — a filename alone can name two loaded copies. A
    // non-participating plugin's override is excluded before conflict/diff computation — it can
    // never contribute a conflict, regardless of its field values. Null (the default) means every
    // plugin in conflictingRecords participates, preserving prior behavior for existing callers.
    ClassifyResult Classify(
        IReadOnlyList<RecordDetail> conflictingRecords,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters,
        Func<string, RecordLookupEntry?>? resolveFormKey = null,
        IReadOnlyDictionary<string, bool>? pluginParticipates = null);
}
