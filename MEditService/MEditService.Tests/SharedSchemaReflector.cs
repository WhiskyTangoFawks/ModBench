using MEditService.Core.Schema;

namespace MEditService.Tests;

public static class SharedSchemaReflector
{
    public static ISchemaReflector Instance { get; } = new SchemaReflector();
}
