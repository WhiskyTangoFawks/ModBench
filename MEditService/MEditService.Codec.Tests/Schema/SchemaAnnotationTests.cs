using MEditService.Codec.Schema;
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

    [Fact]
    public void ASkyrimRecordsScripts_AlignByTheKeysXEditSortsThemBy()
    {
        var adapter = SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)["qust"]
            .RecordColumns.Single(c => c.Name == "VirtualMachineAdapter").Field;
        FieldMetadata Member(FieldMetadata owner, string name) => owner.Fields.Require().Single(f => f.Name == name);
        var scripts = Member(adapter, "Scripts");
        var aliases = Member(adapter, "Aliases");

        Assert.Equal(["Name"], scripts.KeyMembers);
        Assert.Equal(["Name"], Member(scripts.ElementType.Require(), "Properties").KeyMembers);
        Assert.Equal(["Stage", "StageIndex"], Member(adapter, "Fragments").KeyMembers);
        Assert.Equal(["Property.Object", "Property.Alias"], aliases.KeyMembers);
        Assert.Equal(["Name"], Member(aliases.ElementType.Require(), "Scripts").KeyMembers);
    }

    [Fact]
    public void ASkyrimScriptObjectBoundToAnAlias_HoldsNoObject()
    {
        var property = SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)["qust"]
            .RecordColumns.Single(c => c.Name == "VirtualMachineAdapter").Field
            .Fields.Require().Single(f => f.Name == "Aliases").ElementType.Require()
            .Fields.Require().Single(f => f.Name == "Property");

        Assert.True(property.Fields.Require().Single(f => f.Name == "Object").AllowsNull);
    }
}
