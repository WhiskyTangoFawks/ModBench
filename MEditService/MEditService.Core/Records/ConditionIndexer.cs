using DuckDB.NET.Data;
using MEditService.Core.Schema;

namespace MEditService.Core.Records;

// Lays a record's parsed conditions out as relational rows: one `conditions` row per condition,
// its used parameters spread across `condition_parameters`. The codec owns what a condition means
// (per game); this owns where its parts are stored. [ADR-0032, mirrors VmadIndexer]
//
// #166: also collects the condition's three FormKey-bearing slots (a Form-category parameter, the
// Run-On reference, the Use-Global comparison target) into `refs`, the same shared list VmadIndexer
// appends to — so a record referenced only by a condition surfaces in form_references / the
// Referenced-By tab (previously a gap: ConditionIndexer parsed these FormKeys but never fed them
// anywhere). FieldPath reproduces Edits/ConditionPath.Build/BuildParameter's own format
// (`CTDA\<FieldPath>\<Index>\<SubField>`) rather than importing it — Records/ doesn't reference
// Edits/ (the dependency runs the other way, e.g. EditOrchestrator/ReferenceValidator already
// import Records/), the same reason VmadIndexer reproduces VmadPath.Build's format inline instead
// of importing Edits.VmadPath.
internal sealed class ConditionIndexer(DuckDBAppender conditions, DuckDBAppender parameters, List<FormRef> refs)
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
                CollectConditionRefs(formKey, recordType, owner.FieldPath, ci, condition);

                for (var pi = 0; pi < condition.Parameters.Count; pi++)
                    AppendParameter(formKey, plugin, recordType, owner.FieldPath, ci, pi, condition.Parameters[pi]);
            }
        }
    }

    // Mirrors VmadIndexer.AppendProperty's `refs.Add` for VMAD Object properties — same shared
    // list, same "no source EditorID" convention (VmadIndexer passes null too; ResolveFormKey
    // reads the *target's* EditorID via form_lookup regardless of what's stored here).
    private void CollectConditionRefs(string formKey, string recordType, string fieldPath, int index, ParsedCondition c)
    {
        if (c.RunOnTarget == "Reference" && c.RunOnReference is { Length: > 0 } runOnRef)
            refs.Add(new FormRef(formKey, runOnRef, ConditionSubFieldPath(fieldPath, index, "RunOn"), recordType, null));

        if (c.UseGlobal && c.ComparisonGlobal is { Length: > 0 } comparisonGlobal)
            refs.Add(new FormRef(formKey, comparisonGlobal, ConditionSubFieldPath(fieldPath, index, "Comparison"), recordType, null));

        for (var pi = 0; pi < c.Parameters.Count; pi++)
        {
            var param = c.Parameters[pi];
            if (param.Category == ConditionParamCategory.Form && param.FormKey is { Length: > 0 } paramFormKey)
                refs.Add(new FormRef(
                    formKey, paramFormKey, ConditionSubFieldPath(fieldPath, index, $@"Parameter\{pi}"), recordType, null));
        }
    }

    // Matches Edits/ConditionPath.Build's format exactly (see class comment for why this reproduces
    // rather than imports it).
    private static string ConditionSubFieldPath(string fieldPath, int index, string subField) =>
        $@"CTDA\{fieldPath}\{index}\{subField}";

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
