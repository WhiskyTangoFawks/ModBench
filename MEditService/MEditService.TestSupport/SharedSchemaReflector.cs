using MEditService.Codec.Schema;

namespace MEditService.TestSupport;

public static class SharedSchemaReflector
{
    public static SchemaReflector Instance { get; } = new SchemaReflector();
}
