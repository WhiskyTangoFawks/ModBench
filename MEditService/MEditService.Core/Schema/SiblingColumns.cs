using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>What happens when several concrete subclasses share one GRUP signature and so contribute
/// to one table. A same-named member that agrees in shape becomes one column whose enum domain is the
/// union of theirs; one that disagrees in shape becomes a column per shape, named apart; one that
/// disagrees in scalar type becomes a single read-only text column that dispatches on the record's
/// runtime type.</summary>
internal static class SiblingColumns
{
    // A column's ApiType that means "not a single scalar value" — reflection produces these two
    // (ListLeaves.BuildListColumn / StructLeaves.BuildStructColumn); everything else ColumnReflection.GetColumnInfo can return is scalar.
    private static readonly HashSet<string> NonScalarApiTypes = new(StringComparer.Ordinal) { "array", "struct" };

    // Distinguishes OMOD's Properties (mergeable — every sibling's element is the same
    // struct{property: enum, step: float, plus the sparse union of the seven leaf types' own
    // value/value2/record/function_type/enum_int_value}, only the enum's own member-name domain
    // differs per sibling — that union is independent of T, so it's identical across every
    // sibling too) from DMGT's DamageTypes (not mergeable — DamageType's element is a struct of two
    // formlinks, DamageTypeIndexed's is a bare uint, no field names in common at all). Two enum
    // leaves are always considered compatible here — their domains get unioned by the caller, not
    // by this check — with one exception: bit-ness is part of an enum's domain (every member
    // carries a bit, or none does), and a union of a bitmask domain with a plain one is neither, so
    // that much must still match. Everything else (Type, IsArray, AllowsNull, and recursively
    // Fields/ElementType) must match exactly, including field *presence*: a name only one side
    // declares is a real conflict, not something a domain union can paper over.
    private static bool IsSameShapeExceptEnumDomain(FieldMetadata? a, FieldMetadata? b)
    {
        if (a == null || b == null) return a == b;
        if (a.Type != b.Type || a.IsArray != b.IsArray || a.AllowsNull != b.AllowsNull || a.IsBitmask != b.IsBitmask)
            return false;
        if (a.Type == "enum") return true;

        if (a.Fields == null != (b.Fields == null)) return false;
        if (a.Fields != null && b.Fields != null)
        {
            if (a.Fields.Count != b.Fields.Count) return false;
            foreach (var fa in a.Fields)
            {
                var fb = b.Fields.FirstOrDefault(f => f.Name == fa.Name);
                if (fb == null || !IsSameShapeExceptEnumDomain(fa, fb)) return false;
            }
        }

        return IsSameShapeExceptEnumDomain(a.ElementType, b.ElementType);
    }

    // IsSameShapeExceptEnumDomain applied to two columns, with the *column's own* AllowsNull
    // normalized away first. That flag is bookkeeping this ladder itself introduces (a column
    // becomes AllowsNull once it's dispatch-guarded — MergeNonScalarByEnumDomain,
    // SplitNonScalarByShape), not a property of the underlying Mutagen shape — comparing it here
    // would make the routing decision depend on whether this column happened to be merged already,
    // not on whether the sibling's shape actually matches. A freshly-reflected sibling spec is
    // never itself AllowsNull for this reason, so leaving the raw comparison in would falsely
    // report a shape mismatch for a real match the moment a column had already merged once.
    private static bool IsSameColumnShapeExceptEnumDomain(ColumnSpec a, ColumnSpec b) =>
        IsSameShapeExceptEnumDomain(
            a.ToFieldMetadata() with { AllowsNull = false },
            b.ToFieldMetadata() with { AllowsNull = false });

    // Folds one sibling's version of a column into the accumulating union. The rule is
    // shape-based, never keyed by table or signature name — see BuildSchema's caller comment for
    // why that matters (a hypothetical third subclass, or another game's own signature, must
    // be handled with no code change here).
    //
    //   - not present yet on any sibling seen so far: add it as-is, but nullable — not every
    //     sibling declares it. Real today, not hypothetical: GlobalFloat.OutputChar (confirmed
    //     against Global.xml) is declared only on IGlobalFloatGetter — GlobalInt/Short/Bool have
    //     nothing under that name — so it's exactly this branch, load-bearing right now, not a
    //     shape kept only for a future third subclass.
    //   - present already, identical shape (same DuckDbType + ApiType): leave it. This is the
    //     common case — a member declared on the shared abstract base (EditorID, Unknown, MaxRank,
    //     ...) is already reachable, and reads correctly, off *every* sibling instance via ordinary
    //     interface dispatch, because the reflected PropertyInfo comes from an interface every
    //     sibling implements, not from one sibling's own interface.
    //   - present already, conflicting SCALAR shape (GMST/GLOB's per-subclass Data: Int32?/Single?/
    //     TranslatedString?/Boolean?/UInt32?): widen to a read-only text column whose Extract
    //     resolves the record's actual sibling at read time and only ever invokes *that* sibling's
    //     own PropertyInfo — never a foreign one, which is what made the original bug's silent
    //     try/catch swallow every non-winning subclass's value to null.
    //   - present already, conflicting NON-scalar shape, structurally identical except which enum
    //     member names the shared "which property" leaf allows (OMOD's Properties — every sibling's
    //     element is the same struct, the seven-leaf sparse union included, only the "which
    //     property" enum's own domain differs): merge into one column, keeping the typed shape and
    //     dispatching Extract to whichever sibling's own (already-correct) reflected Extract
    //     matches the record's runtime type — never a foreign one. See MergeNonScalarByEnumDomain.
    //   - present already, conflicting NON-scalar shape, structurally different (DMGT's
    //     DamageTypes — DamageType's element is a struct of two formlinks, DamageTypeIndexed's is a
    //     bare uint, no field names in common): split into two columns, one per shape, each
    //     dispatch-guarded to its own declaring sibling(s) by construction rather than a swallowed
    //     throw. See SplitNonScalarByShape.
    internal static void MergeSiblingColumn(
        List<ColumnSpec> columns,
        Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>> widenedDispatch,
        Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>> nonScalarMergeDispatch,
        Type winnerGetterType, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var existingIndex = columns.FindIndex(c => c.Name == siblingSpec.Name);
        if (existingIndex < 0)
        {
            columns.Add(siblingSpec with { AllowsNull = true });
            return;
        }

        var existing = columns[existingIndex];

        if (widenedDispatch.TryGetValue(existing.Name, out var dispatch))
        {
            // Already widened by an earlier conflicting sibling for this table — extend the same
            // dispatch list rather than re-deriving it (a fifth sibling, as GMST's Data has, must
            // still only ever read its own PropertyInfo).
            dispatch.Add((siblingGetterType, siblingSpec.Extract));
            return;
        }

        if (nonScalarMergeDispatch.ContainsKey(existing.Name))
        {
            // Already merged by an earlier conflicting sibling. Nothing guarantees a later sibling
            // sharing this column's *name* also shares the shape the earlier ones merged on — this
            // must re-check, not assume: BuildForCategory is game-generic (any Mutagen.Bethesda.
            // {category}), so a genuinely mismatched third-plus sibling here is not an FO4-only
            // hypothetical, and skipping this check let UnionEnumDomains' by-name Fields lookup
            // throw uncaught, taking out schema construction for the whole category.
            if (IsSameColumnShapeExceptEnumDomain(existing, siblingSpec))
            {
                // Extend the same dispatch list AND fold this sibling's own enum domain into the
                // running union (a fifth OMOD-shaped sibling must still contribute its own T's
                // member names, not just the second one).
                MergeNonScalarByEnumDomain(
                    columns, existingIndex, nonScalarMergeDispatch, winnerGetterType, siblingGetterType, siblingSpec);
                return;
            }

            // Genuinely mismatched. `existing` is already a merged, multi-sibling-safe column —
            // its Extract dispatches correctly across every sibling folded into it so far — so this
            // never touches it; retroactively re-splitting an already-merged group is speculative
            // machinery for a conflict no supported game currently has (same trade-off
            // SplitNonScalarByShape itself declines below). The mismatched sibling gets its own
            // column instead of being silently dropped.
            AddAsOwnColumn(columns, siblingGetterType, siblingSpec);
            return;
        }

        if (NonScalarApiTypes.Contains(existing.ApiType) || NonScalarApiTypes.Contains(siblingSpec.ApiType))
        {
            if (IsSameColumnShapeExceptEnumDomain(existing, siblingSpec))
            {
                MergeNonScalarByEnumDomain(
                    columns, existingIndex, nonScalarMergeDispatch, winnerGetterType, siblingGetterType, siblingSpec);
                return;
            }

            // Not the same shape at all (e.g. DMGT's DamageTypes: DamageType's struct-of-
            // formlinks vs DamageTypeIndexed's bare uint) — no field names in common, so there is
            // nothing for a domain union to reconcile. Split into two columns, one per shape.
            SplitNonScalarByShape(columns, existingIndex, winnerGetterType, siblingGetterType, siblingSpec);
            return;
        }

        if (existing.DuckDbType == siblingSpec.DuckDbType && existing.ApiType == siblingSpec.ApiType)
            return; // same shape — shared-ancestor member, existing extractor already reads it fine

        WidenScalarByRuntimeType(
            columns, existingIndex, widenedDispatch, winnerGetterType, siblingGetterType, siblingSpec);
    }

    // The last rung: two siblings disagree on a *scalar* field's CLR type, so the column gives up
    // its type and becomes read-only text whose Extract dispatches on the record's runtime type.
    // Exactly two in Fallout 4 (gmst.data, glob.data). No single JSON path has consistent semantics
    // for one of these, which is what IsWidened tells the generated views.
    private static void WidenScalarByRuntimeType(
        List<ColumnSpec> columns,
        int existingIndex,
        Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>> widenedDispatch,
        Type winnerGetterType, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var existing = columns[existingIndex];
        var list = new List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>
        {
            (winnerGetterType, existing.Extract),
            (siblingGetterType, siblingSpec.Extract),
        };
        widenedDispatch[existing.Name] = list;

        object? WidenedExtract(IMajorRecordGetter r)
        {
            foreach (var (type, extract) in list)
                if (type.IsInstanceOfType(r))
                    return WidenedLeaf.FormatWidenedValue(extract(r));
            return null;
        }

        columns[existingIndex] = existing with
        {
            DuckDbType = "VARCHAR",
            ApiType = "string",
            Extract = WidenedExtract,
            // The marker generated views key off, set at the one rung that creates this shape
            // rather than re-derived later from a heuristic over the resulting column.
            IsWidened = true,
            ViewDefaultLiteral = null,
            IsFlagsEnum = false,
            // Editing a widened value is out of scope; the write path already refuses a leaf that
            // carries no writer (see RecordFieldWriter.TryApply).
            Apply = LeafWrite.ReadOnly<IMajorRecord>(
                "widened scalar column: sibling subclasses disagree on this field's CLR type, so " +
                "there is no single value shape to write"),
            IsArray = false,
            ElementType = null,
            SubFields = null,
            EnumMembers = LeafSpec.NoEnumMembers,
            ValidFormKeyTypes = LeafSpec.NoFormKeyTypes,
            AllowsNull = true,
        };
    }

    // OMOD's Properties rung — every sibling's element is the exact same struct shape
    // (IsSameShapeExceptEnumDomain already confirmed this, the leaf union included — see that
    // method's own comment), so unlike WidenScalarByRuntimeType there is no need to give up the
    // typed shape at all.
    // Each sibling's own ColumnReflection.ReflectColumns call already built a fully self-consistent, correctly-typed
    // Extract for *that* sibling's own runtime type (BuildSchema calls ColumnReflection.ReflectColumns once per
    // sibling independently) — the hazard is only ever the merged schema calling the
    // *winner's* Extract against a foreign instance. Dispatching by runtime type to the matching
    // sibling's own pre-built Extract, exactly like WidenScalarByRuntimeType, avoids that without any
    // per-element reflection: the raw JSON each sibling's Extract already produces is correctly
    // shaped for its own element type, so nothing here needs to touch it beyond picking the right
    // one to call.
    private static void MergeNonScalarByEnumDomain(
        List<ColumnSpec> columns,
        int existingIndex,
        Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>> nonScalarMergeDispatch,
        Type winnerGetterType, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var existing = columns[existingIndex];

        // First conflicting sibling seeds the dispatch list with the winner's own Extract; a later
        // conflicting sibling (a fifth OMOD-shaped subclass, hypothetically) extends the same list
        // rather than re-deriving it, exactly like WidenScalarByRuntimeType.
        if (!nonScalarMergeDispatch.TryGetValue(existing.Name, out var list))
            nonScalarMergeDispatch[existing.Name] = list = [(winnerGetterType, existing.Extract)];
        list.Add((siblingGetterType, siblingSpec.Extract));

        object? MergedExtract(IMajorRecordGetter r)
        {
            foreach (var (type, extract) in list)
                if (type.IsInstanceOfType(r))
                    return extract(r);
            return null;
        }

        // The winner's own metadata (element/sub-field shape) is kept as-is — IsSameShapeExceptEnumDomain
        // already confirmed it matches every sibling field-for-field — except any enum leaf's
        // members, which become the union of every sibling's own domain (OMOD's `property`
        // sub-field: Armor.Property ∪ Npc.Property ∪ Weapon.Property ∪ NoneProperty's empty set).
        var mergedElementType = existing.ElementType != null && siblingSpec.ElementType != null
            ? UnionEnumDomains(existing.ElementType, siblingSpec.ElementType)
            : existing.ElementType;
        var mergedSubFields = existing.SubFields != null && siblingSpec.SubFields != null
            ? existing.SubFields.Select(fa =>
                UnionEnumDomains(fa, siblingSpec.SubFields.First(fb => fb.Name == fa.Name))).ToList()
            : existing.SubFields;

        columns[existingIndex] = existing with
        {
            Extract = MergedExtract,
            ElementType = mergedElementType,
            SubFields = mergedSubFields,
            // existing.EnumMembers is left untouched here (never unioned): this function is only
            // reached once IsSameColumnShapeExceptEnumDomain has confirmed existing.ApiType ==
            // siblingSpec.ApiType, and both of this function's callers are themselves gated behind
            // NonScalarApiTypes.Contains(existing.ApiType) — array or struct only, never "enum" — so
            // the top-level column's own EnumMembers has nothing to union here. The real per-leaf
            // enum-domain union (OMOD's `property` sub-field) happens above, inside UnionEnumDomains.
            // Same reason WidenScalarByRuntimeType's own column sets this: becoming dispatch-guarded
            // means every row of a non-matching sibling now legitimately reads null through this
            // column — false here would assert a guarantee the dispatch no longer keeps.
            AllowsNull = true,
        };
    }

    // Recursively unions an enum leaf's members across two structurally-identical-except-domain
    // shapes (IsSameShapeExceptEnumDomain's own counterpart) — every non-enum leaf, and every
    // struct/array's own shape, is already identical, so this only ever changes an enum's member
    // names, never any other field.
    private static FieldMetadata UnionEnumDomains(FieldMetadata a, FieldMetadata b)
    {
        if (a.Type == "enum")
            // Deduped by value, not by whole member: two siblings naming the same value must yield
            // one dropdown entry, and the first occurrence's own bit and label are the ones kept.
            return a with { EnumMembers = [.. a.EnumMembers.Concat(b.EnumMembers).DistinctBy(m => m.Value, StringComparer.Ordinal)] };
        if (a.Fields != null && b.Fields != null)
            return a with { Fields = a.Fields.Select(fa => UnionEnumDomains(fa, b.Fields.First(fb => fb.Name == fa.Name))).ToList() };
        if (a.ElementType != null && b.ElementType != null)
            return a with { ElementType = UnionEnumDomains(a.ElementType, b.ElementType) };
        return a;
    }

    // A small, hand-curated disambiguation for a split column's name — the same convention
    // RecordDisplayNames already uses for xEdit-sourced display labels, not a merge-decision rule
    // (the decision to split at all is shape-based, made above; only the resulting *label* is
    // curated here, same as RecordDisplayNames and ModHeaderSchema.MapToXEditFlagName already do for
    // the reflected schema's other curated labels). One entry today: DMGT's DamageTypeIndexed shape. xEdit itself never disambiguates
    // this — wbDefinitionsFO4.pas unions both forms under one form-version-gated 'Damage Types'
    // field, since a DamageType record can never be both forms at once — so *some* label is
    // unavoidable here (a genuine platform limitation: Mutagen models the two forms as two
    // co-existing classes, not a version-gated union). 'actor_value_indices' borrows xEdit's own
    // element vocabulary for that shape ('Actor Value Index'), the closest thing to not diverging
    // from xEdit at all (ADR-0034).
    private static readonly Dictionary<string, string> SplitColumnNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["damage_types"] = "actor_value_indices",
    };

    // A plain scalar leaf (no further substructure) — used to decide, shape-based rather than
    // win-order-based, which side of a split keeps the property's own base name. See
    // SplitNonScalarByShape.
    private static bool IsScalarElementShape(FieldMetadata? elementType) =>
        elementType is { Fields: null, ElementType: null };

    private static string QualifiedSplitName(string baseName, ColumnSpec scalarShapeSpec) =>
        SplitColumnNames.TryGetValue(baseName, out var name)
            ? name
            // Shape-derived fallback for an unmapped future conflict (no code change needed) —
            // not pretty, but deterministic and never a table/signature name.
            : $"{baseName}_{scalarShapeSpec.ElementType?.Type ?? scalarShapeSpec.ApiType}";

    // Cheap collision guard for a computed column name (curated or shape-derived-fallback) against
    // whatever is already in `columns` — a curated or fallback name colliding with an unrelated
    // existing column would otherwise reach TableDdlBuilder.CreateTables as two ColumnSpecs
    // sharing one name, which fails the whole table's CREATE TABLE at DDL time, not just this field.
    private static string UniqueColumnName(List<ColumnSpec> columns, string candidate)
    {
        var name = candidate;
        var suffix = 2;
        while (columns.Any(c => c.Name == name))
        {
            name = $"{candidate}_{suffix}";
            suffix++;
        }
        return name;
    }

    // The struct/richer shape always keeps the property's own name; the plain-scalar shape
    // always gets the disambiguated name. This holds regardless of which subclass wins schema
    // discovery (see BuildForCategory's own comment: that race is a reflection-order artifact,
    // never something callers may rely on) — but only for the one-scalar-one-struct pairing DMGT
    // actually exercises, which is what lets this rename an *already-placed* winner column rather
    // than only ever appending the sibling's. It is NOT win-order-independent for a two-scalar or
    // two-struct conflict: IsScalarElementShape can't tell those two apart, so both fall through to
    // the `else` branch below and the discovery winner keeps the base name — the exact reflection-
    // order artifact the guarantee above disclaims. No supported game has that conflict today, and
    // building a shape-based discriminator for it would mean inventing one with nothing real to
    // validate it against; left as a documented gap, not built.
    //
    // Scoped to two siblings — DMGT's only real case today. A hypothetical third sibling sharing
    // one of these two shapes would need to re-resolve which of the two split columns to extend,
    // which this does not attempt (no real data exercises it; a documented gap).
    //
    // Both resulting columns get a type-checked Extract (a foreign read is impossible by
    // construction, not merely swallowed by the pre-existing catch-all) — both are new paths this
    // rung adds, the winner's own column included, since it may be the one getting renamed here. Both are also
    // AllowsNull: true — becoming dispatch-guarded means every row of the *other* shape now
    // legitimately reads null through each column, on both sides of the split, not just the newly
    // appended one.
    private static void SplitNonScalarByShape(
        List<ColumnSpec> columns, int existingIndex,
        Type winnerGetterType, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var existing = columns[existingIndex];
        var baseName = existing.Name; // == siblingSpec.Name, that's why they collided above

        var existingIsScalar = IsScalarElementShape(existing.ElementType);
        var siblingIsScalar = IsScalarElementShape(siblingSpec.ElementType);

        if (existingIsScalar && !siblingIsScalar)
        {
            // The winner turned out to be the plain shape — rename it off the base name, then
            // reclaim the base name for the sibling's struct shape, so the result is identical to
            // the opposite win order below.
            var qualified = UniqueColumnName(columns, QualifiedSplitName(baseName, existing));
            columns[existingIndex] = Guarded(existing, winnerGetterType) with { Name = qualified, AllowsNull = true };
            columns.Add(Guarded(siblingSpec, siblingGetterType) with
            {
                Name = UniqueColumnName(columns, baseName),
                AllowsNull = true,
            });
        }
        else
        {
            columns[existingIndex] = Guarded(existing, winnerGetterType) with { AllowsNull = true }; // stays at baseName
            var qualified = UniqueColumnName(columns, QualifiedSplitName(baseName, siblingIsScalar ? siblingSpec : existing));
            columns.Add(Guarded(siblingSpec, siblingGetterType) with { Name = qualified, AllowsNull = true });
        }

        static ColumnSpec Guarded(ColumnSpec spec, Type ownerGetterType)
        {
            var innerExtract = spec.Extract;
            return spec with { Extract = r => ownerGetterType.IsInstanceOfType(r) ? innerExtract(r) : null };
        }
    }

    // The fast-path counterpart to SplitNonScalarByShape, for a sibling that turned out not
    // to share an *already-merged* column's shape (see the nonScalarMergeDispatch branch above) —
    // the merged column is left untouched (it is already correct for every sibling folded into it),
    // so this only ever adds the mismatched sibling as its own column, guarded the same way.
    private static void AddAsOwnColumn(List<ColumnSpec> columns, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var innerExtract = siblingSpec.Extract;
        var name = UniqueColumnName(columns, QualifiedSplitName(siblingSpec.Name, siblingSpec));
        columns.Add(siblingSpec with
        {
            Name = name,
            Extract = r => siblingGetterType.IsInstanceOfType(r) ? innerExtract(r) : null,
            AllowsNull = true,
        });
    }
}
