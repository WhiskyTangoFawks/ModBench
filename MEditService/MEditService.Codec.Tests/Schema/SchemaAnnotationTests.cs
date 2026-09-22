using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Indexing;

/// <summary>The shipped annotation table resolves cleanly against the real assembly, so a Mutagen
/// rename that leaves a stale annotation behind fails here rather than in a user's first
/// load.</summary>
public sealed class SchemaAnnotationTests
{
    [Fact]
    public void ShippedFallout4Table_EveryEntryResolves()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        Assert.NotEmpty(schemas);
    }
}
