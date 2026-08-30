using MEditService.Core.Schema;

namespace MEditService.Tests;

public static class SharedSchemaReflector
{
    public static SchemaReflector Instance { get; } = new SchemaReflector();
}
