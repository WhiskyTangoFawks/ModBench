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
}
