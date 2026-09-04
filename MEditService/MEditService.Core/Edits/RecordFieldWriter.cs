using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

internal enum FieldApplyOutcome
{
    Applied,

    /// <summary>Never a silent no-op: the caller refuses.</summary>
    ReadOnly,

    /// <summary>Also a schema column this record's runtime subclass lacks (sibling-merge, e.g. GLOB's <c>output_char</c>).</summary>
    NotFound,

    /// <summary>Never conflated with success: the applier must not return without writing while the edit
    /// reports Applied. Also a scalar/FormLink converter that declined; the fix is the same, send a
    /// value the field accepts.</summary>
    ValueShapeMismatch,

    /// <summary>Its own value because it cannot be inferred from "rejected and the value is an array": a
    /// well-typed element's declined sub-field reaches that shape too.</summary>
    ListElementTypeUnresolved,

    /// <summary>Its own value because "send a value this field accepts" is false here: the shape was never the problem.</summary>
    NestedFieldReadOnly,

    /// <summary>A boundary array op (remove past the end, move first up/last down): nothing to commit, and
    /// never a refusal, since the request was already satisfied.</summary>
    NoOp,

    /// <summary>xEdit writes keyed arrays sorted by key (<c>wbArrayS</c>) and the game reads whichever it
    /// meets first, so a duplicate is a collision; the outcome carries the key so the refusal can name it.</summary>
    DuplicateKeyInKeyedArray,
}

/// <summary>The constructor rejects a duplicate-key outcome with no key, which is what keeps the implicit
/// conversion from a bare outcome safe.</summary>
internal readonly record struct FieldApplyResult
{
    internal FieldApplyResult(FieldApplyOutcome outcome, string? duplicateKey = null)
    {
        if ((outcome == FieldApplyOutcome.DuplicateKeyInKeyedArray) != (duplicateKey is not null))
        {
            throw new ArgumentException(
                "A duplicate-key refusal names its key, and no other outcome carries one.", nameof(duplicateKey));
        }

        Outcome = outcome;
        DuplicateKey = duplicateKey;
    }

    internal FieldApplyOutcome Outcome { get; }
    internal string? DuplicateKey { get; }

    public static implicit operator FieldApplyResult(FieldApplyOutcome outcome) => new(outcome);
}

/// <summary>The single dispatch point for applying a field value; semantics live in <see cref="ColumnSpec.Apply"/>.
/// Complex fields are applied as one atomic value, never per-element, and the record mutated is a throwaway.</summary>
internal static class RecordFieldWriter
{
    internal static FieldApplyResult TryApply(
        IMajorRecord record,
        string recordType,
        string fieldPath,
        JsonElement value,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (fieldPath.Equals(EditorIdFieldPath, StringComparison.Ordinal))
            return ApplyEditorId(record, value);

        if (fieldPath.Equals(IsPartialFormFieldPath, StringComparison.Ordinal))
            return ApplyIsPartialForm(record, value);

        if (!schemas.TryGetValue(recordType, out var schema))
            return FieldApplyOutcome.NotFound;
        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath);
        if (col == null)
            return FieldApplyOutcome.NotFound;

        // An array op envelope is detected by shape (an object with an "op" member), since it only
        // ever targets an ordinary reflected column.
        if (TryGetOpName(value, out var arrayOpName) && ArrayOpWriter.IsArrayOp(arrayOpName))
            return ArrayOpWriter.Apply(record, col, arrayOpName, value);

        if (col.Apply.Writer is not { } apply)
            return FieldApplyOutcome.ReadOnly;

        // A keyed array is written back in key order, whatever order the payload arrived in, and
        // two elements sharing a key are refused before anything is written (KeyedArrays).
        value = KeyedArrays.Normalize(value, col.ToFieldMetadata(), out var duplicateKey);
        if (duplicateKey != null) return new(FieldApplyOutcome.DuplicateKeyInKeyedArray, duplicateKey);

        // Each applier answer is a different reason with a different fix, so each maps to its own outcome.
        return apply(record, value) switch
        {
            ApplyOutcome.Applied => FieldApplyOutcome.Applied,
            ApplyOutcome.PropertyNotFound => FieldApplyOutcome.NotFound,
            ApplyOutcome.ListElementTypeUnresolved => FieldApplyOutcome.ListElementTypeUnresolved,
            ApplyOutcome.SubFieldReadOnly => FieldApplyOutcome.NestedFieldReadOnly,
            _ => FieldApplyOutcome.ValueShapeMismatch,
        };
    }

    /// <summary>Internal so <see cref="RecordEditService"/>'s Partial Form guard can exempt exactly this literal.</summary>
    internal const string EditorIdFieldPath = "editor_id";

    // Dispatched ahead of the reflected columns because SchemaReflector excludes EditorID as an
    // identity column. Null clears it (legal: the layout has a bare-FormKey file name); anything else
    // is refused as NotFound like every other mistyped value.
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

    /// <summary>Internal so <see cref="RecordEditService"/>'s Partial Form guard can exempt it: clearing
    /// the flag is the only way out of that read-only state.</summary>
    internal const string IsPartialFormFieldPath = "is_partial_form";

    // MajorRecordFlagsRaw is header metadata the reflected schema never reaches. An ineligible type
    // refuses rather than flipping bit 14's other meaning; xEdit's SetIsPartialForm coerces to
    // False instead, a deliberate divergence on an internal contract ADR-0034 does not reach.
    private static FieldApplyOutcome ApplyIsPartialForm(IMajorRecord record, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False)
            return FieldApplyOutcome.NotFound;

        if (!PartialFormFlag.IsPartialFormable(record.GetType()))
            return FieldApplyOutcome.NotFound;

        PartialFormFlag.Set(record, value.GetBoolean());
        return FieldApplyOutcome.Applied;
    }

    // Never throws on a malformed envelope: a non-object, absent or non-string "op" simply fails to
    // match, so a plain scalar or struct write falls back to the whole-value write.
    private static bool TryGetOpName(JsonElement value, out string opName)
    {
        opName = "";
        if (value.ValueKind != JsonValueKind.Object) return false;
        if (!value.TryGetProperty("op", out var opEl) || opEl.ValueKind != JsonValueKind.String) return false;
        opName = opEl.GetString()!;
        return true;
    }
}
