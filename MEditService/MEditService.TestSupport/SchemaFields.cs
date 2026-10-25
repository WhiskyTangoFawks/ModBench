using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.TestSupport;

public static class SchemaFields
{
    /// <summary>The field at <paramref name="path"/> below <paramref name="table"/>: a column's name, then member names,
    /// with <c>[]</c> for an array's element.</summary>
    public static FieldMetadata At(GameRelease release, string table, string path)
    {
        var hops = path.Split('.');
        var field = SharedSchemaReflector.Instance.GetSchemas(release)[table].RecordColumns.Single(column => column.Name == hops[0]).Field;
        foreach (var hop in hops[1..])
        {
            field = hop == "[]"
                ? field.ElementType ?? throw new InvalidOperationException($"Expected '{field.Name}' to be an array.")
                : (field.Fields ?? throw new InvalidOperationException($"Expected '{field.Name}' to have members.")).Single(member => member.Name == hop);
        }
        return field;
    }

    /// <summary>Every column of every table, as <c>table.column</c>.</summary>
    public static IEnumerable<(string Path, FieldMetadata Field)> Columns(GameRelease release) =>
        SharedSchemaReflector.Instance.GetSchemas(release)
            .SelectMany(table => table.Value.RecordColumns.Select(column => ($"{table.Key}.{column.Name}", column.Field)));

    /// <summary>Every column and every field below one: <c>[]</c> for an array's element, <c>.member</c>
    /// for a member, <c>&lt;leaf&gt;</c> for a union member's shape under that leaf.</summary>
    public static IEnumerable<(string Path, FieldMetadata Field)> All(GameRelease release) =>
        Columns(release).SelectMany(column => Below(column.Path, column.Field));

    /// <summary><paramref name="field"/> and every field below it, spelled as <see cref="All"/> spells them.</summary>
    public static IEnumerable<(string Path, FieldMetadata Field)> Below(string path, FieldMetadata field) =>
        new[] { (path, field) }
            .Concat(field.ElementType is { } element ? Below($"{path}[]", element) : [])
            .Concat((field.Fields ?? []).SelectMany(member => Below($"{path}.{member.Name}", member)))
            .Concat((field.Variants ?? new Dictionary<string, FieldMetadata>()).SelectMany(variant => Below($"{path}<{variant.Key}>", variant.Value)));
}
