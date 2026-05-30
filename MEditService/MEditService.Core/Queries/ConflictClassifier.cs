namespace MEditService.Core.Queries;

public sealed class ConflictClassifier : IConflictClassifier
{
    public IReadOnlyList<FieldDiff> ComputeDiffs(IReadOnlyList<RecordDetail> overrides)
    {
        if (overrides.Count == 0) return [];

        var winner = overrides.First(o => o.IsWinner);
        var fieldNames = overrides[0].Fields.Select(f => f.Metadata.Name).ToList();

        return fieldNames.Select(fieldName =>
        {
            var values = overrides.ToDictionary(
                o => o.Plugin,
                o => o.Fields.FirstOrDefault(f => f.Metadata.Name == fieldName)?.Value);

            var distinctValues = values.Values
                .Select(v => v?.ToString())
                .Distinct()
                .ToList();

            var isConflict = distinctValues.Count > 1;
            var winnerValue = values.GetValueOrDefault(winner.Plugin);

            return new FieldDiff(fieldName, values, isConflict, winner.Plugin, winnerValue);
        })
        .Where(d => d.Values.Values.Any(v => v != null))
        .ToList();
    }
}
