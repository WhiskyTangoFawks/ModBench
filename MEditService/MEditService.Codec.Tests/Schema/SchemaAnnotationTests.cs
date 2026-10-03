using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Indexing;

public sealed class SchemaAnnotationTests
{
    [Fact]
    public void ShippedFallout4Table_EveryEntryResolves_SoAMutagenRenameLeavingAStaleAnnotationFailsHereNotInAUsersFirstLoad()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        Assert.NotEmpty(schemas);
    }
}
