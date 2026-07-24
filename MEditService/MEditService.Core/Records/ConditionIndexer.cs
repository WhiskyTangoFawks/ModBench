using DuckDB.NET.Data;
using MEditService.Core.Schema;

namespace MEditService.Core.Records;

// Lays a record's parsed conditions out as relational rows: one `conditions` row per condition,
// its used parameters spread across `condition_parameters`. The codec owns what a condition means
// (per game); this owns where its parts are stored. [ADR-0032, mirrors VmadIndexer]
internal sealed class ConditionIndexer(DuckDBAppender conditions, DuckDBAppender parameters)
{
    public void IndexRecord(
        string formKey, string plugin, string recordType, IEnumerable<ConditionOwner> owners)
    {
        foreach (var owner in owners)
        {
            for (var ci = 0; ci < owner.Conditions.Count; ci++)
            {
                var condition = owner.Conditions[ci];
                AppendCondition(formKey, plugin, recordType, owner.FieldPath, ci, condition);

                for (var pi = 0; pi < condition.Parameters.Count; pi++)
                    AppendParameter(formKey, plugin, recordType, owner.FieldPath, ci, pi, condition.Parameters[pi]);
            }
        }
    }

    private void AppendCondition(
        string formKey, string plugin, string recordType, string fieldPath, int index, ParsedCondition c)
    {
        var row = conditions.CreateRow();
        row.AppendValue(formKey);
        row.AppendValue(plugin);
        row.AppendValue(fieldPath);
        row.AppendValue((int?)index);
        row.AppendValue(recordType);
        row.AppendValue(c.Function);
        row.AppendValue(c.Operator.ToString());
        row.AppendValue((bool?)c.Or);
        row.AppendValue(c.RunOnTarget);
        DuckDbAppend.Nullable(row, c.RunOnReference);
        row.AppendValue((bool?)c.UseGlobal);
        DuckDbAppend.Nullable(row, c.ComparisonFloat);
        DuckDbAppend.Nullable(row, c.ComparisonGlobal);
        row.EndRow();
    }

    private void AppendParameter(
        string formKey, string plugin, string recordType, string fieldPath,
        int conditionIndex, int paramIndex, ParsedConditionParam p)
    {
        var row = parameters.CreateRow();
        row.AppendValue(formKey);
        row.AppendValue(plugin);
        row.AppendValue(fieldPath);
        row.AppendValue((int?)conditionIndex);
        row.AppendValue((int?)paramIndex);
        row.AppendValue(recordType);
        row.AppendValue(p.Category.ToString());
        row.AppendValue(p.TypeName);
        DuckDbAppend.Nullable(row, p.Number);
        DuckDbAppend.Nullable(row, p.FormKey);
        DuckDbAppend.Nullable(row, p.Text);
        row.EndRow();
    }
}
