using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests;

public static class SharedSchemaReflector
{
    public static SchemaReflector Instance { get; } = new SchemaReflector();

    /// <summary>The first leaf of an abstract-element array's own discriminator, read off the
    /// reflected schema. The rule an <c>array_add</c> default follows is "the first leaf the schema
    /// lists" (#710), so a test naming a class name as a literal would pin the leaf, not the
    /// rule.</summary>
    public static string FirstArrayElementLeaf(string table, string column, string discriminator) =>
        Instance.GetSchemas(GameRelease.Fallout4)[table]
            .RecordColumns.Single(c => c.Name == column)
            .ElementType!.Fields!.Single(f => f.Name == discriminator)
            .EnumMembers[0].Value;
}
