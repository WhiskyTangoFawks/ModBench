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

    /// <summary>#503: the field is writable, but the value is not the shape it takes — an array field
    /// given something that is not a JSON array, or a struct field given something that is not a JSON
    /// object. That is the shape a per-element edit sends when nothing reconstructed the whole complex
    /// value first, and it used to be indistinguishable from success: the applier returned without
    /// writing and <see cref="TryApply"/> answered <see cref="Applied"/> anyway.</summary>
    ValueShapeMismatch,
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
/// deserializes the record's source text, applies here, and re-serializes. Nothing about a loaded
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
        if (fieldPath.Equals(EditorIdFieldPath, StringComparison.Ordinal))
            return ApplyEditorId(record, value);

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

        // #503: the applier's own answer, not an assumption. `false` means it recognised the field and
        // declined the value's shape — the whole point of the delegate returning anything at all.
        return col.Apply(record, value)
            ? FieldApplyOutcome.Applied
            : FieldApplyOutcome.ValueShapeMismatch;
    }

    /// <summary>
    /// The field path an EditorID edit arrives under — the same snake_case spelling every reflected
    /// column uses, and the same one the read model already publishes the value under
    /// (<c>form_lookup.editor_id</c>, <c>RecordViewBuilder</c>'s own <c>editor_id</c>).
    /// </summary>
    private const string EditorIdFieldPath = "editor_id";

    /// <summary>
    /// EditorID, dispatched ahead of the reflected columns because it is not one of them:
    /// <see cref="MEditService.Core.Schema.SchemaReflector"/>'s <c>BaseSkip</c> excludes it alongside
    /// <c>FormKey</c>, since both are the row's own identity columns carried separately rather than
    /// record data. That exclusion is right for the schema and is left alone — but it also meant no
    /// write path could reach EditorID at all, so <see cref="TryApply"/> answered
    /// <see cref="FieldApplyOutcome.NotFound"/> for it and the edit refused before any file was
    /// touched. #453's scope 3 needs the edit to exist before its rename can mean anything, so it is
    /// dispatched here rather than by widening the reflected schema.
    ///
    /// <para>Unlike <c>FormKey</c> — which is genuinely read-only here, because moving one is a
    /// renumber with a reference cascade (<c>RecordEditService.RenumberRecord</c>) — an EditorID is
    /// ordinary editable data that xEdit has always let you change. What makes it special is only that
    /// the source unit's <i>file name</i> carries it, which is <c>RecordEditService</c>'s problem and
    /// not this method's: the field lands here, and the rename follows from it there.</para>
    ///
    /// <para>A JSON null clears the EditorID, which is legal (the layout has a bare-FormKey file name
    /// for exactly that case). Anything that is not a string or null is not an EditorID and is refused
    /// as <see cref="FieldApplyOutcome.NotFound"/>, matching how every other mistyped value fails
    /// rather than throwing out of the write path.</para>
    /// </summary>
    private static FieldApplyOutcome ApplyEditorId(IMajorRecord record, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                record.EditorID = value.GetString();
                return FieldApplyOutcome.Applied;
            case JsonValueKind.Null:
                record.EditorID = null;
                return FieldApplyOutcome.Applied;
            default:
                return FieldApplyOutcome.NotFound;
        }
    }

    // #426: a VMAD path carries either a plain scalar property value (the #415 shape, unchanged)
    // or a structural op — add/remove script, set script flags, add/remove property, set type, set
    // property flags. The two are distinguished by shape, not by path: `value` doubles as
    // VmadCodec's own `op` parameter when it is a JSON object carrying an `"op"` string member,
    // reusing the exact envelope VmadCodecTests already pins (`{"op": "add_script", ...}`) rather
    // than inventing a second wire contract. A script-level path (`VMAD\<Script>`, no property
    // segment) is only ever a structural op — there is no scalar "whole script" value to set — so
    // it falls through to NotFound when `value` isn't an op envelope.
    //
    // The one accepted ambiguity: a Struct-typed property whose own member happens to be named
    // "op" would misparse as an op envelope instead of a scalar struct write. Papyrus property
    // names are author-chosen and "op" collides with nothing this codebase or Bethesda's own
    // scripts use, so this is a documented, not a defended, edge case.
    private static FieldApplyOutcome ApplyVmadField(IMajorRecord record, string fieldPath, JsonElement value)
    {
        if (record is not IHaveVirtualMachineAdapter vmadRecord) return FieldApplyOutcome.NotFound;

        if (TryGetOpName(value, out var opName))
        {
            if (VmadPath.TryParse(fieldPath, out var opPropScript, out var opPropName))
                return ToOutcome(VmadCodec.ApplyPropertyOp(vmadRecord, opPropScript, opPropName, opName, value));
            if (VmadPath.TryParseScript(fieldPath, out var opScriptName))
                return ToOutcome(VmadCodec.ApplyScriptOp(vmadRecord, opScriptName, opName, value));
            return FieldApplyOutcome.NotFound;
        }

        return VmadPath.TryParse(fieldPath, out var scriptName, out var propName)
            ? ToOutcome(VmadCodec.ApplyFieldValue(vmadRecord, scriptName, propName, value))
            : FieldApplyOutcome.NotFound;
    }

    // Never throws on a malformed envelope: a non-object value, an absent "op", or a non-string
    // "op" all simply fail to match, so a plain scalar write (a JSON number/string/bool/array, or
    // an Object-typed property's own `{formKey, alias}`) can never be mistaken for one — those
    // never carry an "op" member — and the caller falls back to the scalar path or NotFound.
    private static bool TryGetOpName(JsonElement value, out string opName)
    {
        opName = "";
        if (value.ValueKind != JsonValueKind.Object) return false;
        if (!value.TryGetProperty("op", out var opEl) || opEl.ValueKind != JsonValueKind.String) return false;
        opName = opEl.GetString()!;
        return true;
    }

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
