namespace MEditService.Core.Queries;

public sealed class ConflictClassifier : IConflictClassifier
{
    public ClassifyResult Classify(IReadOnlyList<RecordDetail> conflictingRecords)
    {
        if (conflictingRecords.Count <= 1)
        {
            var pluginStates = conflictingRecords.Count == 1
                ? new Dictionary<string, ConflictThis> { [conflictingRecords[0].Plugin] = ConflictThis.OnlyOne }
                : new Dictionary<string, ConflictThis>();
            return new ClassifyResult(ConflictAll.OnlyOne, pluginStates, []);
        }

        var master = conflictingRecords[0];
        var winner = conflictingRecords.First(o => o.IsWinner);
        var masterValues = IndexByName(master.Fields);
        var fieldNames = master.Fields.Select(f => f.Metadata.Name).ToList();

        var diffs = fieldNames
            .Select(fieldName =>
            {
                var values = conflictingRecords.ToDictionary(
                    o => o.Plugin,
                    o => o.Fields.FirstOrDefault(f => f.Metadata.Name == fieldName)?.Value);
                var winnerValue = values.GetValueOrDefault(winner.Plugin);
                return new FieldDiff(fieldName, values, winner.Plugin, winnerValue);
            })
            .Where(d => d.Values.Values.Any(v => v != null))
            .ToList();

        var conflictAll = ComputeConflictAll(master.Plugin, masterValues, conflictingRecords, diffs);

        var pluginConflictThis = conflictingRecords.ToDictionary(
            o => o.Plugin,
            o => ComputeConflictThis(o, master.Plugin, masterValues, winner, conflictingRecords));

        return new ClassifyResult(conflictAll, pluginConflictThis, diffs);
    }

    private static ConflictAll ComputeConflictAll(
        string masterPlugin,
        Dictionary<string, object?> masterValues,
        IReadOnlyList<RecordDetail> overrides,
        IReadOnlyList<FieldDiff> diffs)
    {
        var hasAnyChange = overrides.Skip(1).Any(o =>
            o.Fields.Any(f => f.Value != null && !ValuesEqual(f.Value, masterValues.GetValueOrDefault(f.Metadata.Name))));

        if (!hasAnyChange) return ConflictAll.NoConflict;

        var hasConflict = diffs.Any(d =>
            d.Values
                .Where(kv => kv.Key != masterPlugin && kv.Value != null)
                .Select(kv => kv.Value?.ToString())
                .Distinct()
                .Skip(1)
                .Any());

        return hasConflict ? ConflictAll.Conflict : ConflictAll.Override;
    }

    private static ConflictThis ComputeConflictThis(
        RecordDetail plugin,
        string masterPlugin,
        Dictionary<string, object?> masterValues,
        RecordDetail winner,
        IReadOnlyList<RecordDetail> all)
    {
        if (plugin.Plugin == masterPlugin) return ConflictThis.Master;

        var pluginValues = IndexByName(plugin.Fields);

        var changedFields = pluginValues
            .Where(kv => kv.Value != null && !ValuesEqual(kv.Value, masterValues.GetValueOrDefault(kv.Key)))
            .Select(kv => kv.Key)
            .ToHashSet();

        if (changedFields.Count == 0) return ConflictThis.IdenticalToMaster;

        if (plugin.IsWinner)
        {
            var contested = all
                .Where(o => o.Plugin != masterPlugin && o.Plugin != plugin.Plugin)
                .SelectMany(o => o.Fields)
                .Any(f =>
                    changedFields.Contains(f.Metadata.Name) &&
                    f.Value != null &&
                    !ValuesEqual(f.Value, pluginValues.GetValueOrDefault(f.Metadata.Name)));
            return contested ? ConflictThis.ConflictWins : ConflictThis.Override;
        }
        else
        {
            var winnerValues = IndexByName(winner.Fields);
            var lost = changedFields.Any(field =>
            {
                var winnerVal = winnerValues.GetValueOrDefault(field);
                return winnerVal != null && !ValuesEqual(winnerVal, pluginValues.GetValueOrDefault(field));
            });
            return lost ? ConflictThis.ConflictLoses : ConflictThis.Override;
        }
    }

    private static Dictionary<string, object?> IndexByName(IReadOnlyList<FieldValue> fields) =>
        fields.ToDictionary(f => f.Metadata.Name, f => f.Value);

    // JsonElement doesn't override Equals() — compare by raw JSON text to handle array/struct fields
    private static bool ValuesEqual(object? a, object? b)
    {
        if (a is System.Text.Json.JsonElement ja && b is System.Text.Json.JsonElement jb)
            return ja.GetRawText() == jb.GetRawText();
        return Equals(a, b);
    }
}
