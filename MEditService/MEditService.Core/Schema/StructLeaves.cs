using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>A Loqui sub-record, as one struct column or one nested struct member. Written as a single
/// atomic value: the whole object is built and every member applied before anything attaches to the
/// record, so a rejected member leaves nothing written. One applier serves both levels, at any depth
/// the walk builds.</summary>
internal static class StructLeaves
{
    // #643: a nested Loqui struct writes through the same one struct-object applier the top-level
    // struct column uses (ApplyStructJson — #548's own semantics, abstract-union discriminator
    // resolution and same-concrete-type object reuse included), at any depth SubFieldReflection.BuildSubSchema itself
    // builds, since each level's own BuildStructSubField wires the same applier again.
    //
    // The unwritable residue keeps #642's refusal instead of a delegate that could never succeed:
    // a getter type with no resolvable Setter class at all, and an abstract Setter whose own
    // sub-schema exposes no concrete_type discriminator — a union SchemaAnnotations.ExcludedUnions
    // names, so no payload can ever carry the discriminator ApplyStructJson would need. Refusing up
    // front as not-editable names the real problem, where a ValueRejected from the missing
    // discriminator would claim the value's shape was wrong.
    internal static SubFieldSpec? BuildStructSubField(
        PropertyInfo prop, Type core, string colName,
        GameReflection game, Type[] path, int depth, ILogger logger)
    {
        var sub = SubFieldReflection.BuildSubSchema(core, game, logger, path, depth);
        if (sub.Count == 0) return SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, core, "empty nested struct");
        var g = ReflectedTypes.SubGetter(prop);
        var pName = prop.Name;
        var setterType = ReflectedTypes.GetSetterType(core);
        var writable = setterType != null && (!setterType.IsAbstract || HasDiscriminator(sub));
        return new(colName, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            obj => { var v = g(obj); return v == null ? null : SubFieldValues.ExtractSubObject(v, sub); },
            Apply: writable
                ? LeafWrite.Writable<object>((obj, val) => ApplyStructJson(obj, val, pName, setterType!, sub))
                : LeafWrite.ReadOnly<object>(
                    "nested struct with no usable write door: no resolvable Loqui setter class, or an " +
                    "excluded union whose discriminator can never appear in a payload"),
            SubFields: sub,
            // #642: a payload that names an unwritable sub-field must refuse the whole write rather
            // than silently drop it while the caller reports success (SubFieldSpec's own doc comment
            // has the full "a read-only leaf is not one thing" reasoning).
            TargetingRefuses: !writable);
    }

    /// <summary>
    /// The one struct-object write, shared by the top-level struct column
    /// (<see cref="BuildStructColumn"/>, operating on the record itself) and every nested struct
    /// sub-field (<see cref="BuildStructSubField"/>, operating on whichever enclosing struct/array
    /// element object <see cref="SubFieldValues.ApplySubFields"/> hands it) — #643 extends #548's generalization
    /// down through nesting by reusing this exact body rather than duplicating it.
    ///
    /// <para>The struct half of <see cref="ListLeaves.ApplyListJson"/>'s own shape guard — a struct field is
    /// written as one atomic value, so a bare member value is refused rather than silently dropped
    /// while the write path reports success.</para>
    ///
    /// <para>The same refusal also covers a well-formed object whose own member value was declined
    /// (<see cref="SubFieldValues.ApplySubFields"/>' <c>ValueRejected</c> fold), or that names a still-unwritable
    /// nested sub-field (#642's <c>SubFieldReadOnly</c> fold) — <c>SetValue</c> is skipped in both
    /// cases too, so a struct write with one bad or unwritable member never attaches its
    /// partially-built value to the target, matching <see cref="ListLeaves.ApplyListJson"/>'s own "before
    /// <c>newList</c> is attached" guarantee at every nesting level this method is wired at.</para>
    ///
    /// <para><paramref name="setterType"/> is a union base for an abstract Loqui union (ANpcLevel,
    /// ALocationTarget, ...) or a concrete one whose sub-schema carries a discriminator
    /// (<see cref="IsUnionWritten"/>) — the concrete type is resolved off the incoming JSON's own
    /// discriminator first, refusing (<c>ValueRejected</c>) rather than constructing the wrong
    /// class (or, for an abstract base, crashing) when it can't be. Only reused when the target's existing value is already that same
    /// concrete type — switching concrete leaf (NpcLevel to PcLevelMult, WorldspaceNavmeshParent to
    /// CellNavmeshParent) cannot reuse the old object, so it constructs fresh instead.</para>
    ///
    /// <para><c>PropertyNotFound</c> when the target's runtime type doesn't declare the property —
    /// impossible for a top-level column (reflection found the property on that very type), but a
    /// nested sub-field can be an abstract-union shared member applied against a sibling leaf that
    /// lacks it, where the silent-no-op convention (<see cref="LeafWriters.MakeApplier"/>'s own) is exactly
    /// right.</para>
    /// </summary>
    private static ApplyOutcome ApplyStructJson(
        object target, JsonElement json, string pName, Type setterType, IReadOnlyList<SubFieldSpec> subFields)
    {
        if (json.ValueKind == JsonValueKind.Null) return ClearStruct(target, pName);
        if (json.ValueKind != JsonValueKind.Object) return ApplyOutcome.ValueRejected;

        var concreteType = setterType;
        if (IsUnionWritten(setterType, subFields))
        {
            if (LoquiUnions.ResolveUnionConcreteType(setterType, json) is not { } resolved)
                return ApplyOutcome.ValueRejected;
            concreteType = resolved;
        }

        var rp = target.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
        if (rp == null) return ApplyOutcome.PropertyNotFound;
        var existing = rp.GetValue(target);
        // Exactly the named leaf, not merely assignable to it: an AlphaLayer is a BaseLayer, and
        // switching to the base must build a bare one rather than keep the subclass.
        var obj = existing is { } same && same.GetType() == concreteType ? same : Activator.CreateInstance(concreteType)!;
        var subOutcome = SubFieldValues.ApplySubFields(obj, json, subFields);
        if (subOutcome != ApplyOutcome.Applied) return subOutcome;
        if (rp.CanWrite) rp.SetValue(target, obj);
        return ApplyOutcome.Applied;
    }

    /// <summary>A struct member the payload gives as <c>null</c> is the absence of a struct, not a
    /// malformed one: that is exactly what this field's own <c>Extract</c> answers for a subrecord
    /// the record does not carry (a scene adapter's <c>on_begin</c> fragment, say), so resending a
    /// record's own read value has to mean "still none" rather than being refused. Clearing it is
    /// also the honest reading of a user who empties the member deliberately — the same value, the
    /// same result.</summary>
    private static ApplyOutcome ClearStruct(object target, string pName)
    {
        var rp = target.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
        if (rp == null) return ApplyOutcome.PropertyNotFound;
        if (rp.CanWrite) rp.SetValue(target, null);
        return ApplyOutcome.Applied;
    }

    // A union base is written by the leaf the payload names: abstract, so nothing else could be
    // constructed, or concrete with a discriminator in its own sub-schema (ScriptProperty), where
    // building the base regardless would silently discard the leaf the payload asked for.
    internal static bool IsUnionWritten(Type setterType, IReadOnlyList<SubFieldSpec>? subFields) =>
        setterType.IsAbstract || HasDiscriminator(subFields);

    private static bool HasDiscriminator(IReadOnlyList<SubFieldSpec>? subFields) =>
        subFields?.Any(f => f.Name == LoquiUnions.UnionTypeDiscriminator) ?? false;

    internal static ColumnInfoResult? BuildStructColumn(
        PropertyInfo prop, Type core, GameReflection game, ILogger logger)
    {
        var subFields = SubFieldReflection.BuildSubSchema(core, game, logger, SubFieldReflection.RootPath);
        if (subFields.Count == 0) return SchemaRefusals.ReportUnclassified<ColumnInfoResult>(game, logger, prop, core, "empty struct");

        var subFieldMetas = subFields.ConvertAll(s => s.ToFieldMetadata());

        object? Extractor(IMajorRecordGetter r)
        {
            var obj = ReflectedTypes.ReadOrNull(r, prop);
            return obj == null ? null
                : JsonSerializer.Serialize(SubFieldValues.ExtractSubObject(obj, subFields));
        }

        var setterType = ReflectedTypes.GetSetterType(core);
        var pName = prop.Name;
        var apply = LeafWrite.ReadOnly<IMajorRecord>(
            "struct column with no resolvable Loqui setter class, so nothing can be constructed to write onto");
        if (setterType != null)
        {
            // ApplyStructJson carries the whole contract (shape guard, discriminator resolution,
            // refuse-before-attach) — shared with every nested struct sub-field since #643, so the
            // column and sub-field write paths cannot drift apart.
            apply = LeafWrite.Writable<IMajorRecord>(
                (record, json) => ApplyStructJson(record, json, pName, setterType, subFields));
        }

        return new("VARCHAR", Extractor, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, apply,
            SubFieldMetas: subFieldMetas);
    }
}
