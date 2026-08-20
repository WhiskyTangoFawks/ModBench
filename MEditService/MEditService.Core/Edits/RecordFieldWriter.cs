using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>What applying one field value to one record can come to.</summary>
internal enum FieldApplyOutcome
{
    Applied,

    /// <summary>The field exists but carries no write delegate — a read-only column (masters,
    /// FormKey, the #263 widened text columns). Never a silent no-op: the caller refuses.</summary>
    ReadOnly,

    /// <summary>No field of this name on this record type.</summary>
    NotFound,
}

/// <summary>
/// Applies one field value to one live Mutagen record — the single dispatch point every write path
/// goes through, restored for #415 from the write half #410 retired with the pending-change model.
/// What came back is only the dispatch: every codec it dispatches *to*
/// (<see cref="ColumnSpec.Apply"/>, <see cref="VmadCodec"/>, <see cref="IConditionCodec"/>,
/// <see cref="VmadPath"/>, <see cref="ConditionPath"/>) survived #410 untouched, so the field
/// semantics here are the ones the suite has always pinned, not a second implementation of them.
///
/// <para>Complex fields (CONTEXT.md: array or struct) are applied as one atomic value, never
/// per-element — <see cref="ColumnSpec.Apply"/> takes the whole field's JSON, which is exactly the
/// field-level write ADR-0041 asks for. The record this mutates is a throwaway: the edit path
/// deserializes the record's ledger text, applies here, and re-serializes. Nothing about a loaded
/// plugin is touched.</para>
/// </summary>
internal static class RecordFieldWriter
{
    internal static FieldApplyOutcome TryApply(
        IMajorRecord record,
        string recordType,
        string fieldPath,
        JsonElement value,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release)
    {
        if (VmadPath.IsVmadPath(fieldPath))
            return ApplyVmadField(record, fieldPath, value);

        if (ConditionPath.IsConditionPath(fieldPath))
            return ApplyConditionField(record, fieldPath, value, release);

        // #154: dispatches on whichever of the record's actual condition-owning fields this is (not
        // just "Conditions") — an instance is in hand here, so the check reflects off record.GetType()
        // directly rather than going through the record-type string.
        var codec = ConditionCodecRegistry.For(release.ToCategory());
        if (codec != null && codec.IsConditionListField(record.GetType(), fieldPath))
            return ApplyConditionListField(record, fieldPath, value, release);

        // #183/#184: a nested list's own whole-list write, where the composed path names an
        // enclosing array and index before the condition field, routes the same way once it resolves
        // against this concrete record's element type. ApplyListValue itself walks the path at
        // whatever depth it composes, so this only decides whether to route there at all.
        if (codec != null && fieldPath.Contains('[', StringComparison.Ordinal)
            && codec.IsNestedConditionListField(record.GetType(), fieldPath))
        {
            return ApplyConditionListField(record, fieldPath, value, release);
        }

        if (!schemas.TryGetValue(recordType, out var schema))
            return FieldApplyOutcome.NotFound;
        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath);
        if (col == null)
            return FieldApplyOutcome.NotFound;
        if (col.Apply == null)
            return FieldApplyOutcome.ReadOnly;

        col.Apply(record, value);
        return FieldApplyOutcome.Applied;
    }

    private static FieldApplyOutcome ApplyVmadField(IMajorRecord record, string fieldPath, JsonElement value) =>
        record is IHaveVirtualMachineAdapter vmadRecord && VmadPath.TryParse(fieldPath, out var scriptName, out var propName)
            ? ToOutcome(VmadCodec.ApplyFieldValue(vmadRecord, scriptName, propName, value))
            : FieldApplyOutcome.NotFound;

    private static FieldApplyOutcome ToOutcome(VmadApplyResult result) => result switch
    {
        VmadApplyResult.Applied => FieldApplyOutcome.Applied,
        VmadApplyResult.ReadOnly => FieldApplyOutcome.ReadOnly,
        _ => FieldApplyOutcome.NotFound,
    };

    private static FieldApplyOutcome ApplyConditionField(
        IMajorRecord record, string fieldPath, JsonElement value, GameRelease release)
    {
        if (ConditionCodecRegistry.For(release.ToCategory()) is not { } codec)
            return FieldApplyOutcome.NotFound;
        if (!ConditionPath.TryParse(fieldPath, out var ownerPath, out var index, out var subField))
            return FieldApplyOutcome.NotFound;

        return codec.ApplyFieldValue(record, ownerPath, index, subField, value) == ConditionApplyResult.Applied
            ? FieldApplyOutcome.Applied
            : FieldApplyOutcome.NotFound;
    }

    // Whole-list write (#153): fieldPath is the bare owning field name (e.g. "Conditions") and the
    // value is the full ParsedCondition-shaped JSON array — the atomic complex-field write again,
    // one level in.
    private static FieldApplyOutcome ApplyConditionListField(
        IMajorRecord record, string fieldPath, JsonElement value, GameRelease release)
    {
        if (ConditionCodecRegistry.For(release.ToCategory()) is not { } codec)
            return FieldApplyOutcome.NotFound;

        return codec.ApplyListValue(record, fieldPath, value) == ConditionApplyResult.Applied
            ? FieldApplyOutcome.Applied
            : FieldApplyOutcome.NotFound;
    }
}
