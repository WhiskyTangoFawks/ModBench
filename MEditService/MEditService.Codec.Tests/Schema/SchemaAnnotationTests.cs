using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Indexing;

public sealed class SchemaAnnotationTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
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

    [Fact]
    public void AStarfieldArrayXEditSortsByKey_AlignsByThatKey()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield);
        var entries = schemas["lvli"].RecordColumns.Single(c => c.Name == "Entries").Field;

        Assert.Equal(["Faction"], schemas["npc_"].RecordColumns.Single(c => c.Name == "Factions").Field.KeyMembers);
        Assert.Equal(["Level", "Reference"], entries.KeyMembers);
        Assert.Equal(["Count", "Data.ItemCondition", "Data.Owner"], entries.ExtendedKeyMembers);
    }

    private static FieldMetadata QuestAdapterMember(GameRelease release, string path) =>
        path.Split('.').Aggregate(
            SharedSchemaReflector.Instance.GetSchemas(release)["qust"].RecordColumns.Single(c => c.Name == "VirtualMachineAdapter").Field,
            (owner, name) => (owner.ElementType ?? owner).Fields.Require().Single(f => f.Name == name));

    [Theory]
    [InlineData(GameRelease.SkyrimSE, "Scripts", "Name")]
    [InlineData(GameRelease.SkyrimSE, "Scripts.Properties", "Name")]
    [InlineData(GameRelease.SkyrimSE, "Fragments", "Stage,StageIndex")]
    [InlineData(GameRelease.SkyrimSE, "Aliases", "Property.Object,Property.Alias")]
    [InlineData(GameRelease.SkyrimSE, "Aliases.Scripts", "Name")]
    [InlineData(GameRelease.Starfield, "Scripts", "Name")]
    [InlineData(GameRelease.Starfield, "Scripts.Properties", "Name")]
    [InlineData(GameRelease.Starfield, "Scripts.Properties.Members", "Name")]
    [InlineData(GameRelease.Starfield, "Scripts.Properties.Members.Properties", "Name")]
    [InlineData(GameRelease.Starfield, "Scripts.Properties.Structs.Members", "Name")]
    [InlineData(GameRelease.Starfield, "Fragments", "Stage,StageIndex")]
    [InlineData(GameRelease.Starfield, "Aliases", "Property.Alias")]
    [InlineData(GameRelease.Starfield, "Aliases.Scripts", "Name")]
    public void AQuestsScriptArray_AlignsByTheKeysXEditSortsItBy(GameRelease release, string path, string keys)
    {
        Assert.Equal(keys.Split(','), QuestAdapterMember(release, path).KeyMembers);
    }

    [Theory]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void AScriptObjectBoundToAnAlias_HoldsNoObject(GameRelease release)
    {
        Assert.True(QuestAdapterMember(release, "Aliases.Property.Object").AllowsNull);
    }
}
