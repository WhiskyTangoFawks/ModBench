using MEditService.Core.Schema;

namespace MEditService.Tests.TestSupport;

/// <summary>A reflector over the shipped annotation tables with one amendment, through the
/// annotation seam — how a test reaches a schema the shipped tables do not describe (a row naming a
/// type reflection cannot find, a truncation lifted) without a second reflector to keep in step.</summary>
internal static class AmendedSchemaReflector
{
    public static SchemaReflector Fallout4With(Func<SchemaAnnotations, SchemaAnnotations> amend) =>
        new(category => amend(SchemaAnnotations.For(category)));
}
