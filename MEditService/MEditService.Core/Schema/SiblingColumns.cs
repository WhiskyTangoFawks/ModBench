using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>Subclasses sharing one GRUP signature contribute to one table: a member agreeing in
/// shape becomes one column with a unioned enum domain; disagreeing in shape, one column with a
/// variant per record class, written through whichever class the record is.</summary>
internal static class SiblingColumns
{
    // Two enum leaves are compatible except in domain: everything else must match exactly, field
    // presence included; a name only one side declares is a real conflict.
    private static bool IsSameShapeExceptEnumDomain(FieldMetadata? a, FieldMetadata? b)
    {
        if (a == null || b == null) return a == b;
        if (a.Type != b.Type || a.IsArray != b.IsArray || a.AllowsNull != b.AllowsNull)
            return false;
        if (a.Type is "enum" or "flags") return true;

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
            a.ToFieldMetadata() with { AllowsNull = false, Variants = null },
            b.ToFieldMetadata() with { AllowsNull = false, Variants = null });

    /// <summary>Which record class each writer belongs to, so a column shared by several classes
    /// writes through the one the record is.</summary>
    internal sealed record WriterByClass(Type GetterType, LeafWrite<IMajorRecord> Apply);

    // Folds one sibling's column into the union; shape-based, never keyed by table or signature
    // name. Absent: add, nullable (GlobalFloat.OutputChar). Same shape: merge enum domains. Any
    // other disagreement: a variant per class.
    internal static void MergeSiblingColumn(
        List<ColumnSpec> columns,
        Dictionary<string, List<WriterByClass>> writersByColumn,
        Type winnerGetterType, string winnerClassName,
        Type siblingGetterType, string siblingClassName, ColumnSpec siblingSpec)
    {
        var existingIndex = columns.FindIndex(c => c.Name == siblingSpec.Name);
        if (existingIndex < 0)
        {
            columns.Add(siblingSpec with { AllowsNull = true });
            return;
        }

        var existing = columns[existingIndex];
        if (existing.Variants == null && IsSameColumnShapeExceptEnumDomain(existing, siblingSpec))
        {
            columns[existingIndex] = MergeEnumDomains(existing, siblingSpec);
            return;
        }

        // The first disagreeing sibling seeds the variants with the winner's own shape; a later one
        // extends them. Each class writes through its own applier, since the winner's converter is
        // bound to the winner's CLR type.
        if (!writersByColumn.TryGetValue(existing.Name, out var writers))
        {
            writersByColumn[existing.Name] = writers = [new(winnerGetterType, existing.Apply)];
        }
        writers.Add(new(siblingGetterType, siblingSpec.Apply));
        var byClass = writers;

        var variants = new Dictionary<string, FieldMetadata>(
            existing.Variants ?? new Dictionary<string, FieldMetadata> { [winnerClassName] = existing.ToFieldMetadata() with { AllowsNull = false } },
            StringComparer.Ordinal)
        {
            [siblingClassName] = siblingSpec.ToFieldMetadata() with { AllowsNull = false },
        };

        columns[existingIndex] = existing with
        {
            DuckDbType = "VARCHAR",
            Variants = variants,
            ViewDefaultLiteral = null,
            AllowsNull = true,
            Apply = LeafWrite.Writable<IMajorRecord>((record, json) =>
            {
                foreach (var (getterType, apply) in byClass)
                {
                    if (!getterType.IsInstanceOfType(record)) continue;
                    return apply.Writer is { } write ? write(record, json) : ApplyOutcome.SubFieldReadOnly;
                }
                return ApplyOutcome.PropertyNotFound;
            }),
        };
    }

    // The winner's metadata is kept, already confirmed field-for-field, except enum leaves, whose
    // members become the union of every sibling's domain (OMOD's Property sub-field).
    private static ColumnSpec MergeEnumDomains(ColumnSpec existing, ColumnSpec siblingSpec) =>
        existing with
        {
            EnumMembers = UnionEnumDomains(existing.ToFieldMetadata(), siblingSpec.ToFieldMetadata()).EnumMembers,
            ElementType = existing.ElementType != null && siblingSpec.ElementType != null
                ? UnionEnumDomains(existing.ElementType, siblingSpec.ElementType)
                : existing.ElementType,
            SubFields = existing.SubFields != null && siblingSpec.SubFields != null
                ? existing.SubFields.Select(fa =>
                    UnionEnumDomains(fa, siblingSpec.SubFields.First(fb => fb.Name == fa.Name))).ToList()
                : existing.SubFields,
            // Dispatch-guarded means a non-matching sibling's rows legitimately read null.
            AllowsNull = true,
        };

    // IsSameShapeExceptEnumDomain's counterpart: every non-enum leaf and every nested shape is
    // already identical, so only an enum's member names change.
    private static FieldMetadata UnionEnumDomains(FieldMetadata a, FieldMetadata b)
    {
        if (a.Type is "enum" or "flags")
            // Deduped by value, not by whole member: two siblings naming the same value must yield
            // one dropdown entry, and the first occurrence's own bit and label are the ones kept.
            return a with { EnumMembers = [.. a.EnumMembers.Concat(b.EnumMembers).DistinctBy(m => m.Value, StringComparer.Ordinal)] };
        if (a.Fields != null && b.Fields != null)
            return a with { Fields = a.Fields.Select(fa => UnionEnumDomains(fa, b.Fields.First(fb => fb.Name == fa.Name))).ToList() };
        if (a.ElementType != null && b.ElementType != null)
            return a with { ElementType = UnionEnumDomains(a.ElementType, b.ElementType) };
        return a;
    }
}
