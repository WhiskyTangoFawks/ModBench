using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests;

public static class SharedSchemaReflector
{
    public static SchemaReflector Instance { get; } = new SchemaReflector();

    public static string FirstArrayElementLeaf(string table, string column, string discriminator) =>
        Instance.GetSchemas(GameRelease.Fallout4)[table]
            .RecordColumns.Single(c => c.Name == column)
            .Field.ElementSpec!.SubFields!.Single(f => f.Name == discriminator)
            .EnumMembers[0].Value;

    public static string FirstArrayElementLeafSubField(string table, string column, string member, string discriminator) =>
        Instance.GetSchemas(GameRelease.Fallout4)[table]
            .RecordColumns.Single(c => c.Name == column)
            .Field.ElementSpec!.SubFields!.Single(f => f.Name == member)
            .SubFields!.Single(f => f.Name == discriminator)
            .EnumMembers[0].Value;
}
