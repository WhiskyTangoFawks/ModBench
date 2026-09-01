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
    /// FormKey, the widened text columns). Never a silent no-op: the caller refuses.</summary>
    ReadOnly,

    /// <summary>No field of this name on this record type schema, <i>or</i> the schema names
    /// one but this particular record's own runtime type doesn't declare the backing property — the
    /// sibling-merge case, e.g. GLOB's <c>output_char</c> column exists only on <c>GlobalFloat</c>
    /// among the four GLOB subclasses (<see cref="ColumnSpec.Apply"/> answering
    /// <c>ApplyOutcome.PropertyNotFound</c>). Both read the same to a caller: this record genuinely
    /// has no such field.</summary>
    NotFound,

    /// <summary>The field is writable, but the value is not the shape it takes — an array field
    /// given something that is not a JSON array, or a struct field given something that is not a JSON
    /// object. That is the shape a per-element edit sends when nothing reconstructed the whole complex
    /// value first — never conflated with success: the applier must not return without writing while
    /// <see cref="TryApply"/> answers <see cref="Applied"/>.
    ///
    /// <para>Also covers a scalar or FormLink column whose <see cref="ColumnSpec.Apply"/>
    /// answered <c>ApplyOutcome.ValueRejected</c> — a converter that threw or declined (an
    /// unrecognised enum member, a non-numeric string), a JSON <c>null</c> into a non-nullable
    /// column, or an unparseable/wrongly-shaped FormKey. Reused deliberately rather than given its
    /// own <c>RecordEditRefusal</c> member: unlike <c>ListElementTypeUnresolved</c> (whose fix
    /// is a specific, different action — name a discriminator), there is no more specific actionable
    /// fix here beyond "send a value this field accepts", which is exactly what this outcome's
    /// existing generic message already says.</para>
    /// </summary>
    ValueShapeMismatch,

    /// <summary>
    /// Mirrors <see cref="MEditService.Core.Schema.ApplyOutcome.ListElementTypeUnresolved"/>
    /// one-for-one — an array field given an array, where at least one element's own concrete type is
    /// abstract and couldn't be determined from its own payload. Its own value rather than folded into
    /// <see cref="ValueShapeMismatch"/>: inferring it from "the outcome was a rejection and the value
    /// happens to be a genuine JSON array" cannot work — a well-typed element's own declined sub-field
    /// value reaches a rejection with a genuine JSON array too, so only the applier's own answer can
    /// tell them apart.
    /// </summary>
    ListElementTypeUnresolved,

    /// <summary>
    /// Mirrors <see cref="MEditService.Core.Schema.ApplyOutcome.SubFieldReadOnly"/> one-for-one
    /// (#642) — the payload names a sub-field the schema knows about but that carries no write
    /// delegate for a reason that is not a discriminator no-op (today: any nested Loqui struct one
    /// level inside another struct/array column). Its own value rather than folded into
    /// <see cref="ValueShapeMismatch"/>: the two need different messages — "send a value this field
    /// accepts" is actively false here, since the value's shape was never the problem.
    /// </summary>
    NestedFieldReadOnly,

    /// <summary>
    /// #630: an array op envelope (<c>array_remove</c>/<c>array_move_up</c>/<c>array_move_down</c>)
    /// whose own boundary check answered "nothing to do" — removing past the array's end, or moving
    /// the first element up / the last element down. Its own outcome rather than folded into
    /// <see cref="Applied"/>: <see cref="RecordEditService"/> must commit nothing for it (no rename,
    /// no re-serialize, no working-tree write, no <c>ReapplyFilter</c>), which only a distinct
    /// outcome lets it tell apart from a change that genuinely landed. Never a refusal — a boundary
    /// op is not a mistake the caller needs to fix, it is a request that was already satisfied.
    /// </summary>
    NoOp,
}

/// <summary>
/// Applies one field value to one live Mutagen record — the single dispatch point every write path
/// goes through. Only the dispatch lives here: the field semantics live in the codecs it dispatches
/// *to* (<see cref="ColumnSpec.Apply"/>, <see cref="VmadCodec"/>, <see cref="IConditionCodec"/>,
/// <see cref="VmadPath"/>, <see cref="ConditionPath"/>), not in a second implementation.
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

        if (fieldPath.Equals(IsPartialFormFieldPath, StringComparison.Ordinal))
            return ApplyIsPartialForm(record, value);

        if (VmadPath.IsVmadPath(fieldPath))
            return ApplyVmadField(record, fieldPath, value);

        if (ConditionPath.IsConditionPath(fieldPath))
            return ApplyConditionField(record, fieldPath, value, release);

        // Dispatches on whichever of the record's actual condition-owning fields this is (not
        // just "Conditions") — an instance is in hand here, so the check reflects off record.GetType()
        // directly rather than going through the record-type string.
        var codec = ConditionCodecRegistry.For(release.ToCategory());
        if (codec != null && codec.IsConditionListField(record.GetType(), fieldPath))
            return ApplyConditionListField(record, fieldPath, value, release);

        // A nested list's own whole-list write, where the composed path names an
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

        // #630: an array arity/order op envelope — same shape-based detection as VmadField's own
        // op envelopes just above (a JSON object carrying an "op" string member), checked here
        // rather than earlier since it only ever targets an ordinary reflected column, never a
        // VMAD/condition path (both already dispatched above this line).
        if (TryGetOpName(value, out var arrayOpName) && ArrayOpWriter.IsArrayOp(arrayOpName))
            return ArrayOpWriter.Apply(record, col, arrayOpName, value);

        if (col.Apply == null)
            return FieldApplyOutcome.ReadOnly;

        // The applier's own answer, not an assumption — each of these is a different
        // reason with a different fix (see FieldApplyOutcome's own docs), so each translates to its
        // own outcome rather than one undifferentiated refusal.
        return col.Apply(record, value) switch
        {
            ApplyOutcome.Applied => FieldApplyOutcome.Applied,
            ApplyOutcome.PropertyNotFound => FieldApplyOutcome.NotFound,
            ApplyOutcome.ListElementTypeUnresolved => FieldApplyOutcome.ListElementTypeUnresolved,
            ApplyOutcome.SubFieldReadOnly => FieldApplyOutcome.NestedFieldReadOnly,
            _ => FieldApplyOutcome.ValueShapeMismatch,
        };
    }

    /// <summary>
    /// The field path an EditorID edit arrives under — the same snake_case spelling every reflected
    /// column uses, and the same one the read model already publishes the value under
    /// (<c>form_lookup.editor_id</c>, <c>RecordViewBuilder</c>'s own <c>editor_id</c>). Internal
    /// rather than private so <see cref="RecordEditService"/>'s Partial Form guard can
    /// exempt exactly this literal rather than duplicating it.
    /// </summary>
    internal const string EditorIdFieldPath = "editor_id";

    /// <summary>
    /// EditorID, dispatched ahead of the reflected columns because it is not one of them:
    /// <see cref="MEditService.Core.Schema.SchemaReflector"/>'s <c>BaseSkip</c> excludes it alongside
    /// <c>FormKey</c>, since both are the row's own identity columns carried separately rather than
    /// record data. That exclusion is right for the schema and is left alone, so the edit is
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

    /// <summary>
    /// The field path a Partial Form header-flag edit arrives under — snake_case, matching
    /// <see cref="EditorIdFieldPath"/>'s own convention. Internal so
    /// <see cref="RecordEditService"/>'s Partial Form guard can exempt exactly this literal (a
    /// flagged record's own fields are read-only, but this is the one write that must reach the
    /// flag itself — clearing it is the only way out of that read-only state) and so its own
    /// bit-14-only write-surface guard can name it too.
    /// </summary>
    internal const string IsPartialFormFieldPath = "is_partial_form";

    /// <summary>
    /// The one sanctioned write to header flag bit 14 — dispatched ahead of the reflected
    /// columns for the same reason <see cref="ApplyEditorId"/> is: <c>MajorRecordFlagsRaw</c> is in
    /// <see cref="MEditService.Core.Schema.SchemaReflector"/>'s <c>BaseSkip</c> (it is GRUP/header
    /// metadata, not record data), so nothing in the reflected schema could ever reach it.
    ///
    /// <para>Gated by <see cref="Schema.PartialFormFlag.IsPartialFormable"/> — the same container-type
    /// gate the read half (<see cref="Schema.PartialFormFlag.IsSet"/>) already uses:
    /// a record type that can never carry the flag refuses here as
    /// <see cref="FieldApplyOutcome.NotFound"/> (no silent no-op — matching every other refusal in
    /// this class), never silently flipping bit 14's unrelated meaning on that type. xEdit's own
    /// <c>SetIsPartialForm</c> (<c>wbImplementation.pas:14157</c>) instead silently coerces an
    /// ineligible <c>aValue</c> to <c>False</c> — a deliberate divergence, not a missed gesture: this
    /// is an internal write-path contract question (every other <see cref="FieldApplyOutcome"/> here
    /// refuses loudly), not a record-editing UX one, so ADR-0034's xEdit-is-the-reference rule does
    /// not reach it.</para>
    ///
    /// <para>A non-boolean value is not an <c>is_partial_form</c> edit and is refused as
    /// <see cref="FieldApplyOutcome.NotFound"/>, mirroring <see cref="ApplyEditorId"/>'s own handling
    /// of a mistyped value.</para>
    /// </summary>
    private static FieldApplyOutcome ApplyIsPartialForm(IMajorRecord record, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False)
            return FieldApplyOutcome.NotFound;

        if (!PartialFormFlag.IsPartialFormable(record.GetType()))
            return FieldApplyOutcome.NotFound;

        PartialFormFlag.Set(record, value.GetBoolean());
        return FieldApplyOutcome.Applied;
    }

    // A VMAD path carries either a plain scalar property value
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
            // #630 guarded this branch against "array_remove"/etc — ArrayOpWriter's own op names —
            // arriving under a VMAD path and misrouting into VmadCodec.ApplyPropertyOp/ApplyScriptOp
            // as an unrecognised op name. #658 removes that guard: a Papyrus scalar-array property's
            // own arity ops now live here deliberately, under VmadCodec's own vocabulary
            // (add_element/remove_element/move_element_up/move_element_down, chosen precisely to
            // never collide with ArrayOpWriter's array_* names), so the guard's premise — that no
            // legitimate op envelope should ever reach this dispatch for an arity op — is gone. An
            // actual "array_remove" envelope arriving here (a genuine misroute from the ordinary
            // reflected-field path) still falls through to NotFound below on its own, the same as any
            // other opName neither ApplyPropertyOp nor ApplyScriptOp recognises.
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
        // #658: a scalar-array element op's own boundary no-op (VmadCodec.RemoveAt/Move) — mirrors
        // ArrayOpWriter's own NoOp mapping one-for-one, so RecordEditService's existing "commit
        // nothing for a boundary op" handling (no rename, no re-serialize, no working-tree write)
        // applies here unchanged, regardless of which codec answered it.
        VmadApplyResult.NoOp => FieldApplyOutcome.NoOp,
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

    // Whole-list write: fieldPath is the bare owning field name (e.g. "Conditions") and the
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
