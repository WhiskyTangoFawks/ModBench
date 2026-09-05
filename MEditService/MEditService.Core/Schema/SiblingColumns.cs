using System.Text.Json;
using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>Subclasses sharing one GRUP signature contribute to one table: a member every class
/// shapes alike is one column; one they disagree on is one column with a variant per record class,
/// written through the record's own class.</summary>
internal static class SiblingColumns
{
    /// <summary>Which record class each writer belongs to, so a column shared by several classes
    /// writes through the one the record is.</summary>
    internal sealed record WriterByClass(Type GetterType, LeafWrite<IMajorRecord> Apply);

    // Structural, since FieldMetadata's collections compare by reference. The column's own AllowsNull
    // is bookkeeping this fold introduces, not a Mutagen shape property, so it is normalized away.
    private static bool SameShape(ColumnSpec a, ColumnSpec b) =>
        JsonSerializer.Serialize(a.ToFieldMetadata() with { AllowsNull = false })
        == JsonSerializer.Serialize(b.ToFieldMetadata() with { AllowsNull = false });

    // Folds one sibling's column in by shape, never by table or signature name. Absent: add,
    // nullable (GlobalFloat.OutputChar). Same shape: leave. Any disagreement (gmst.Data's scalar
    // type, dmgt.DamageTypes' element, omod.Properties' enum domain): a variant per class.
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
        if (existing.Variants == null && SameShape(existing, siblingSpec)) return;

        // The first disagreeing sibling seeds the variants with the winner's own shape; a later one
        // extends them. Each class writes through its own applier, since the winner's converter is
        // bound to the winner's CLR type.
        if (!writersByColumn.TryGetValue(existing.Name, out var writers))
            writersByColumn[existing.Name] = writers = [new(winnerGetterType, existing.Apply)];
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
}
