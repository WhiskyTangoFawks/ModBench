using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class SchemaAnnotationTests
{
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

    [Theory]
    [InlineData(GameRelease.Fallout4, "npc_", "Factions", "Faction", null)]
    [InlineData(GameRelease.Fallout4, "npc_", "Perks", "Perk", null)]
    [InlineData(GameRelease.Fallout4, "npc_", "Items", "Item.Item", "Item.Count,Data.ItemCondition,Data.Owner")]
    [InlineData(GameRelease.Fallout4, "npc_", "Attacks", "AttackEvent", null)]
    [InlineData(GameRelease.Fallout4, "npc_", "Sounds", "Keyword", null)]
    [InlineData(GameRelease.Fallout4, "npc_", "FaceMorphs", "Index", null)]
    [InlineData(GameRelease.Fallout4, "npc_", "FaceTintingLayers", "Index", null)]
    [InlineData(GameRelease.Fallout4, "npc_", "Properties", "ActorValue", null)]
    [InlineData(GameRelease.Fallout4, "npc_", "ObjectTemplates.[].Properties", "Property", null)]
    [InlineData(GameRelease.Fallout4, "fact", "Relations", "Target", null)]
    [InlineData(GameRelease.Fallout4, "fact", "Ranks", "Number", null)]
    [InlineData(GameRelease.Fallout4, "lvli", "Entries", "Data.Level,Data.Reference", "Data.Count,ExtraData.ItemCondition,ExtraData.Owner")]
    [InlineData(GameRelease.Fallout4, "lvli", "FilterKeywordChances", "FilterKeyword", null)]
    [InlineData(GameRelease.Fallout4, "lvln", "Entries", "Data.Level,Data.Reference", "Data.Count,ExtraData.ItemCondition,ExtraData.Owner")]
    [InlineData(GameRelease.Fallout4, "omod", "Properties", "Property", null)]
    [InlineData(GameRelease.Fallout4, "cont", "Items", "Item.Item", "Item.Count,Data.ItemCondition,Data.Owner")]
    [InlineData(GameRelease.Fallout4, "furn", "Items", "Item.Item", "Item.Count,Data.ItemCondition,Data.Owner")]
    [InlineData(GameRelease.Fallout4, "lens", "Sprites", "LensFlareSpriteId", null)]
    [InlineData(GameRelease.Fallout4, "mswp", "Substitutions", "OriginalMaterial", null)]
    [InlineData(GameRelease.Fallout4, "regn", "Sounds.Sounds", "Sound", null)]
    [InlineData(GameRelease.Fallout4, "misc", "Components", null, null)]
    [InlineData(GameRelease.Fallout4, "perk", "Effects.[].Conditions", "RunOnTabIndex", null)]
    [InlineData(GameRelease.Fallout4, "qust", "Stages", "Index", null)]
    [InlineData(GameRelease.Fallout4, "qust", "Aliases.[].Items", "Item.Item", "Item.Count,Data.ItemCondition,Data.Owner")]
    [InlineData(GameRelease.Fallout4, "lctn", "PersistentActorReferencesAdded", "Actor", null)]
    [InlineData(GameRelease.Fallout4, "lctn", "PersistentActorReferencesStatic", "Actor", null)]
    [InlineData(GameRelease.Fallout4, "lctn", "UniqueActorReferencesAdded", "Ref", null)]
    [InlineData(GameRelease.Fallout4, "lctn", "UniqueActorReferencesStatic", "Ref", null)]
    [InlineData(GameRelease.Fallout4, "lctn", "LocationRefTypeReferencesAdded", "Ref", null)]
    [InlineData(GameRelease.Fallout4, "lctn", "LocationRefTypeReferencesStatic", "Ref", null)]
    [InlineData(GameRelease.Fallout4, "lctn", "WorldspaceCellsAdded", "Location", null)]
    [InlineData(GameRelease.Fallout4, "lctn", "WorldspaceCellsStatic", "Location", null)]
    [InlineData(GameRelease.Fallout4, "lctn", "WorldspaceCellsRemoved", "Location", null)]
    [InlineData(GameRelease.Fallout4, "term", "VirtualMachineAdapter.ScriptFragments.Fragments", "FragmentIndex", null)]
    [InlineData(GameRelease.Fallout4, "term", "Properties", "ActorValue", null)]
    [InlineData(GameRelease.Fallout4, "mgef", "Sounds", "Type", null)]
    [InlineData(GameRelease.Fallout4, "achr", "LinkedReferences", "KeywordOrReference", null)]
    [InlineData(GameRelease.Fallout4, "achr", "ActivateParents.Parents", "Reference", null)]
    [InlineData(GameRelease.Fallout4, "refr", "LinkedReferences", null, null)]
    [InlineData(GameRelease.Fallout4, "navm", "NavmeshGeometry.DoorTriangles", "TriangleBeforeDoor,Door", null)]
    [InlineData(GameRelease.Fallout4, "navm", "PreCutMapEntries", "Reference", null)]
    [InlineData(GameRelease.Fallout4, "navi", "MapInfos", "NavigationMesh", null)]
    [InlineData(GameRelease.Fallout4, "navi", "MapInfos.[].LinkedDoors", "Door", null)]
    [InlineData(GameRelease.Fallout4, "navi", "PreferredPathing.NavmeshTree", "NodeIndex", null)]
    [InlineData(GameRelease.Fallout4, "land", "Layers", "Header.Quadrant,Header.LayerNumber", null)]
    [InlineData(GameRelease.SkyrimSE, "npc_", "Factions", "Faction", null)]
    [InlineData(GameRelease.SkyrimSE, "lvli", "Entries", "Data.Level,Data.Reference", "Data.Count,ExtraData.ItemCondition,ExtraData.Owner")]
    [InlineData(GameRelease.Starfield, "npc_", "Factions", "Faction", null)]
    [InlineData(GameRelease.Starfield, "lvli", "Entries", "Level,Reference", "Count,Data.ItemCondition,Data.Owner")]
    [InlineData(GameRelease.Starfield, "lvlp", "Entries", "Level,Reference", "Count,Conditions")]
    [InlineData(GameRelease.Starfield, "stag", "Tags", "Tag", null)]
    public void AnArrayXEditSorts_AlignsByTheKeyXEditSortsItBy_AndAnyOtherAlignsInSequence(
        GameRelease release, string table, string path, string? keys, string? extendedKeys)
    {
        var array = SchemaFields.At(release, table, path);

        Assert.Equal(keys?.Split(','), array.KeyMembers);
        Assert.Equal(extendedKeys?.Split(','), array.ExtendedKeyMembers);
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
