using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Indexing;

public sealed class SchemaAnnotationTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    public void ShippedTable_EveryEntryResolves_SoAMutagenRenameLeavingAStaleAnnotationFailsHereNotInAUsersFirstLoad(GameRelease release)
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(release);
        Assert.NotEmpty(schemas);
    }

    [Fact]
    public void TheSceneActionTypeKnownDefect_IsNamedInTheSchema_ReadOnlyWithItsReason()
    {
        var type = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["scen"]
            .RecordColumns.Single(c => c.Name == "Actions").Field.ElementType.Require().Fields.Require()
            .Single(f => f.Name == "Type");

        Assert.Equal("ASceneActionType", type.LeafTypeName);
        Assert.Empty(type.Fields.Require());
        Assert.Contains("unimplemented throw upstream", type.ReadOnlyReason, StringComparison.Ordinal);
    }

    [Fact]
    public void ASkyrimArrayXEditSortsByKey_AlignsByThatKey()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE);
        var factions = schemas["npc_"].RecordColumns.Single(c => c.Name == "Factions").Field;
        var entries = schemas["lvli"].RecordColumns.Single(c => c.Name == "Entries").Field;

        Assert.Equal(["Faction"], factions.KeyMembers);
        Assert.Equal(["Data.Level", "Data.Reference"], entries.KeyMembers);
        Assert.Equal(["Data.Count", "ExtraData.ItemCondition", "ExtraData.Owner"], entries.ExtendedKeyMembers);
    }
}
