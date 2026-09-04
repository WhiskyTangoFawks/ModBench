using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>Subclasses sharing one GRUP signature contribute to one table: a member agreeing in
/// shape becomes one column with a unioned enum domain; disagreeing in shape, a column per shape;
/// disagreeing in scalar type, read-only text.</summary>
internal static class SiblingColumns
{
    // The ApiTypes that mean "not a single scalar value"; every other reflected ApiType is scalar.
    private static readonly HashSet<string> NonScalarApiTypes = new(StringComparer.Ordinal) { "array", "struct" };

    // Two enum leaves are compatible except in bit-ness: a union of a bitmask domain with a plain
    // one is neither. Everything else must match exactly, field presence included; a name only one
    // side declares is a real conflict.
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

    // The column's own AllowsNull is bookkeeping this ladder introduces once a column is
    // dispatch-guarded, not a Mutagen shape property, so it is normalized away; an already-merged
    // column would otherwise falsely mismatch.
    private static bool IsSameColumnShapeExceptEnumDomain(ColumnSpec a, ColumnSpec b) =>
        IsSameShapeExceptEnumDomain(
            a.ToFieldMetadata() with { AllowsNull = false },
            b.ToFieldMetadata() with { AllowsNull = false });

    // Folds one sibling's column into the union; shape-based, never keyed by table or signature
    // name. Absent: add, nullable (GlobalFloat.OutputChar). Same shape: leave. Scalar conflict:
    // widen to text. Non-scalar: merge by enum domain, or split per shape.
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
            // A later sibling sharing the name need not share the merged shape; assuming it lets
            // UnionEnumDomains' by-name lookup throw and take out the whole category's schema.
            if (IsSameColumnShapeExceptEnumDomain(existing, siblingSpec))
            {
                // Extend the same dispatch list AND fold this sibling's own enum domain into the
                // running union (a fifth OMOD-shaped sibling must still contribute its own T's
                // member names, not just the second one).
                MergeNonScalarByEnumDomain(
                    columns, existingIndex, nonScalarMergeDispatch, winnerGetterType, siblingGetterType, siblingSpec);
                return;
            }

            // The merged column already dispatches correctly across every sibling folded in, so it is
            // left alone; re-splitting it is machinery for a conflict no supported game has.
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

            // No field names in common (DMGT: struct-of-formlinks vs bare uint), so nothing for a
            // domain union to reconcile; one column per shape.
            SplitNonScalarByShape(columns, existingIndex, winnerGetterType, siblingGetterType, siblingSpec);
            return;
        }

        if (existing.DuckDbType == siblingSpec.DuckDbType && existing.ApiType == siblingSpec.ApiType)
            return; // same shape — shared-ancestor member, existing extractor already reads it fine

        WidenScalarByRuntimeType(
            columns, existingIndex, widenedDispatch, winnerGetterType, siblingGetterType, siblingSpec);
    }

    // Two siblings disagree on a scalar field's CLR type, so the column becomes read-only text
    // dispatching on the record's runtime type. Exactly two in Fallout 4: gmst.data, glob.data.
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

    // Every sibling's element is the same struct shape, so the typed shape is kept. Each sibling's
    // Extract is correct for its type; the hazard is the winner's against a foreign instance,
    // avoided by dispatching on runtime type.
    private static void MergeNonScalarByEnumDomain(
        List<ColumnSpec> columns,
        int existingIndex,
        Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>> nonScalarMergeDispatch,
        Type winnerGetterType, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var existing = columns[existingIndex];

        // The first conflicting sibling seeds the list with the winner's Extract; a later one extends it.
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

        // The winner's metadata is kept, already confirmed field-for-field, except enum leaves, whose
        // members become the union of every sibling's domain (OMOD's `property` sub-field).
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
            // EnumMembers is never unioned here: both callers are gated on an array/struct ApiType, so
            // the column itself has none; the per-leaf union happens in UnionEnumDomains.
            // Dispatch-guarded means a non-matching sibling's rows legitimately read null.
            AllowsNull = true,
        };
    }

    // IsSameShapeExceptEnumDomain's counterpart: every non-enum leaf and every nested shape is
    // already identical, so only an enum's member names change.
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

    // Curated label; splitting itself is shape-based. xEdit unions DMGT's two forms under one
    // 'Damage Types' field, but Mutagen models them as two classes, so some label is unavoidable,
    // and this borrows xEdit's element vocabulary per ADR-0034.
    private static readonly Dictionary<string, string> SplitColumnNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["damage_types"] = "actor_value_indices",
    };

    // Decides, shape-based rather than win-order-based, which side of a split keeps the base name.
    private static bool IsScalarElementShape(FieldMetadata? elementType) =>
        elementType is { Fields: null, ElementType: null };

    private static string QualifiedSplitName(string baseName, ColumnSpec scalarShapeSpec) =>
        SplitColumnNames.TryGetValue(baseName, out var name)
            ? name
            // Shape-derived fallback for an unmapped future conflict (no code change needed) —
            // not pretty, but deterministic and never a table/signature name.
            : $"{baseName}_{scalarShapeSpec.ElementType?.Type ?? scalarShapeSpec.ApiType}";

    // Two ColumnSpecs sharing one name would fail the whole table's CREATE TABLE in TableDdlBuilder,
    // not just this field.
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

    // The richer shape keeps the base name and the plain scalar is renamed, whichever subclass won
    // discovery. Two-scalar, two-struct or three-sibling conflicts fall to win order; no supported
    // game has one.
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

    // For a sibling not sharing an already-merged column's shape: the merged column is left alone
    // and the sibling becomes its own guarded column.
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
