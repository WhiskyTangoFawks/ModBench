namespace MEditService.Core.Queries;

public interface IConflictClassifier
{
    ClassifyResult Classify(IReadOnlyList<RecordDetail> overrides);
}
