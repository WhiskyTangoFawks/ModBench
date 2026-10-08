using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.TestSupport;

public static class SharedSchemaReflector
{
    public static SchemaReflector Instance { get; } = new SchemaReflector();

    public static string FirstArrayElementLeaf(string table, string column, string discriminator) =>
        ElementSubFields(table, column).Single(f => f.Name == discriminator).EnumMembers[0].Value;

    public static string FirstArrayElementLeafSubField(string table, string column, string member, string discriminator) =>
        RequireSubFields(ElementSubFields(table, column).Single(f => f.Name == member), member)
            .Single(f => f.Name == discriminator).EnumMembers[0].Value;

    private static IReadOnlyList<FieldMetadata> ElementSubFields(string table, string column)
    {
        var field = Instance.GetSchemas(GameRelease.Fallout4)[table].RecordColumns.Single(c => c.Name == column).Field;
        var elementSpec = field.ElementType
            ?? throw new InvalidOperationException($"Expected '{table}.{column}' to have an array element spec.");
        return RequireSubFields(elementSpec, column);
    }

    private static IReadOnlyList<FieldMetadata> RequireSubFields(FieldMetadata field, string name) =>
        field.Fields ?? throw new InvalidOperationException($"Expected '{name}' to have sub-fields.");
}
