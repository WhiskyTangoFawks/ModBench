using MEditService.Codec.Schema;

namespace MEditService.Tests.TestSupport;

/// <summary>A reflector over the shipped annotation tables with one amendment, so a test can reach a
/// schema the shipped tables do not describe without a second reflector to keep in step.</summary>
internal static class AmendedSchemaReflector
{
    public static SchemaReflector Fallout4With(Func<SchemaAnnotations, SchemaAnnotations> amend) =>
        new(category => amend(SchemaAnnotations.For(category)));
}
