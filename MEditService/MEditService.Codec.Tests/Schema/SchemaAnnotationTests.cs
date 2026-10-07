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

    [Fact]
    public void TheSceneActionTypeKnownDefect_IsNamedInTheSchema_ReadOnlyWithItsReason()
    {
        var type = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["scen"]
            .RecordColumns.Single(c => c.Name == "Actions").Field.ElementSpec.Require().SubFields.Require()
            .Single(f => f.Name == "Type");

        Assert.Equal("ASceneActionType", type.LeafTypeName);
        Assert.Empty(type.SubFields.Require());
        Assert.Contains("unimplemented throw upstream", type.ReadOnlyReason, StringComparison.Ordinal);
    }
}
