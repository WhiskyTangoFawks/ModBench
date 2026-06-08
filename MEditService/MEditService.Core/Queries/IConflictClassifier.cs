namespace MEditService.Core.Queries;

public interface IConflictClassifier
{
    ClassifyResult Classify(
        IReadOnlyList<RecordDetail> conflictingRecords,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters);
}
