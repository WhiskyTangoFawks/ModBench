using System.Text.Json;
using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

/// <summary>Subclasses sharing one GRUP signature contribute to one table: a member every class
/// shapes alike is one column; any other is one column with a variant per class declaring it, so
/// a write knows which class holds what.</summary>
internal static class SiblingColumns
{
    // Structural, since FieldMetadata's collections compare by reference. The column's own AllowsNull
    // is bookkeeping this fold introduces, not a Mutagen shape property, so it is normalized away.
    private static string Shape(ColumnSpec spec) =>
        JsonSerializer.Serialize(spec.ToFieldMetadata() with { AllowsNull = false });

    /// <summary>The winner's columns first, then those only a sibling declares. A column all classes
    /// declare alike stays as it is; any other carries a variant per declaring class, and one DuckDB
    /// type only where shapes agree.</summary>
    internal static List<ColumnSpec> Fold(IReadOnlyList<(string ClassName, List<ColumnSpec> Columns)> byClass)
    {
        var order = new List<string>();
        var declaring = new Dictionary<string, List<(string ClassName, ColumnSpec Spec)>>(StringComparer.Ordinal);
        foreach (var (className, columns) in byClass)
        {
            foreach (var column in columns)
            {
                if (!declaring.TryGetValue(column.Name, out var list))
                {
                    declaring[column.Name] = list = [];
                    order.Add(column.Name);
                }
                list.Add((className, column));
            }
        }

        var result = new List<ColumnSpec>(order.Count);
        foreach (var name in order)
        {
            var classes = declaring[name];
            var first = classes[0].Spec;
            var shapesAgree = classes.Select(c => Shape(c.Spec)).Distinct(StringComparer.Ordinal).Count() == 1;
            if (shapesAgree && classes.Count == byClass.Count)
            {
                result.Add(first);
                continue;
            }

            result.Add(first with
            {
                DuckDbType = shapesAgree ? first.DuckDbType : "VARCHAR",
                ViewDefaultLiteral = shapesAgree ? first.ViewDefaultLiteral : null,
                AllowsNull = true,
                Variants = classes.ToDictionary(
                    c => c.ClassName, c => c.Spec.ToFieldMetadata() with { AllowsNull = false }, StringComparer.Ordinal),
            });
        }
        return result;
    }
}
