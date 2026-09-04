using System.Text.Json;

namespace MEditService.Core.Schema;

/// <summary>Reading a set of named sub-fields off any object, and folding a JSON object's members
/// back onto one. Shared by every composite leaf kind — a Loqui struct, a Noggog vector, an atomic
/// value, an array element — because none of them differ in how a member is read or written, only in
/// what object the members hang off.</summary>
internal static class SubFieldValues
{
    internal static Dictionary<string, object?> ExtractSubObject(
        object item, IReadOnlyList<SubFieldSpec> fields)
    {
        var dict = new Dictionary<string, object?>();
        foreach (var f in fields) dict[f.Name] = f.Extract(item);
        return dict;
    }

    /// <summary>
    /// Applies every sub-field's own value onto <paramref name="target"/>, folding each member's
    /// <see cref="ApplyOutcome"/> into one whole-object result for the struct/array-element caller.
    ///
    /// <para>A sub-field absent from the incoming JSON is always skipped, not applied at all —
    /// absence is never targeting. A sub-field the payload <i>does</i> name but that carries no
    /// <c>Apply</c> splits in two (#642): the two discriminator fields (OMOD's own <c>value_type</c>,
    /// the abstract-union <c>concrete_type</c>) decide the object's concrete type rather than being set
    /// on it and are consumed off the raw JSON before that object exists — <c>SubFieldSpec.TargetingRefuses</c>
    /// stays <c>false</c> for both, so naming one is still a silent skip, exactly as every write
    /// payload for that shape already does on every call. Every other null-<c>Apply</c> sub-field
    /// (since #643, the unwritable residue only — see <c>SubFieldSpec.TargetingRefuses</c>' own doc)
    /// sets <c>TargetingRefuses: true</c>, so naming <i>that</i> one fails the whole object
    /// via <see cref="ApplyOutcome.SubFieldReadOnly"/> rather than silently discarding the value.</para>
    ///
    /// <para>Of the members that <i>are</i> applied, <see cref="ApplyOutcome.PropertyNotFound"/>
    /// stays a silent no-op here — a sub-field shared across several concrete sibling leaf types that
    /// don't all declare it (OMOD's own sparse leaf-union: <c>value</c>, <c>value2</c>, <c>record</c>,
    /// <c>enum_int_value</c>, <c>function_type</c>) is *expected* to miss on some of them, by design,
    /// every time an element of that shape round-trips. <see cref="ApplyOutcome.ValueRejected"/> — the
    /// property exists on this concrete leaf but the value itself couldn't be converted — fails the
    /// whole object the same way <see cref="ApplyOutcome.SubFieldReadOnly"/> does; both are what
    /// <see cref="ListLeaves.BuildListElement"/> and the struct column's own apply turn into a refusal of the
    /// entire array/struct write before it ever reaches the record (<see cref="ListLeaves.ApplyListJson"/>'s
    /// "before <c>newList</c> is attached" guarantee, extended one level in) — <c>SubFieldReadOnly</c>
    /// takes priority in the result when both occur in the same object, since it is the more specific
    /// diagnosis (the value was never the problem).</para>
    /// </summary>
    internal static ApplyOutcome ApplySubFields(object target, JsonElement json, IReadOnlyList<SubFieldSpec> subFields)
    {
        var rejected = false;
        var notWritable = false;
        var elementTypeUnresolved = false;
        foreach (var sf in subFields)
        {
            if (!json.TryGetProperty(sf.Name, out var sfVal)) continue;
            if (sf.Apply.Writer is not { } apply)
            {
                if (sf.TargetingRefuses) notWritable = true;
                continue;
            }
            // Checked against every failure value, not just ValueRejected: a member's own apply can
            // itself be a nested struct's whole-object write (ApplyStructJson, #643) or a nested
            // list's whole-value write (ListLeaves.ApplyListSubFieldJson) — those answer SubFieldReadOnly (a
            // deeper still-unwritable member) or ListElementTypeUnresolved (a deeper abstract list
            // element with no resolvable discriminator, e.g. an alias element's own `conditions`)
            // the same way a top-level column's apply does, and this fold must not let either
            // signal disappear one level further up. ListElementTypeUnresolved was silently
            // swallowed here until #643 — the exact silent-success class #642 closed for nested
            // structs, one shape over — so it now fails the whole object like the other two.
            switch (apply(target, sfVal))
            {
                case ApplyOutcome.SubFieldReadOnly: notWritable = true; break;
                case ApplyOutcome.ListElementTypeUnresolved: elementTypeUnresolved = true; break;
                case ApplyOutcome.ValueRejected: rejected = true; break;
            }
        }
        // Most-specific diagnosis first when several members fail in one object: "this member has
        // no write door at all" beats "name a discriminator", which beats the generic "send a value
        // this field accepts" — same ordering rationale as the SubFieldReadOnly-over-ValueRejected
        // priority the doc comment above states.
        if (notWritable) return ApplyOutcome.SubFieldReadOnly;
        if (elementTypeUnresolved) return ApplyOutcome.ListElementTypeUnresolved;
        return rejected ? ApplyOutcome.ValueRejected : ApplyOutcome.Applied;
    }
}
