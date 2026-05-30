namespace MEditService.Core.Queries;

public interface IConflictClassifier
{
    IReadOnlyList<FieldDiff> ComputeDiffs(IReadOnlyList<RecordDetail> overrides);
}
