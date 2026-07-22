using MEditService.Core.Records;

namespace MEditService.Core.Queries;

public interface IConflictClassifier
{
    // resolveFormKey: ADR-0031's O(1) lookup (IRecordRepository.ResolveFormKey), batched once per
    // Classify call so every formKey-typed FieldDiff leaf's Resolutions is populated in this same
    // pass rather than round-tripped per value. Null when the caller has no resolver available
    // (existing behavior — no Resolutions populated).
    ClassifyResult Classify(
        IReadOnlyList<RecordDetail> conflictingRecords,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters,
        Func<string, RecordLookupEntry?>? resolveFormKey = null);
}
