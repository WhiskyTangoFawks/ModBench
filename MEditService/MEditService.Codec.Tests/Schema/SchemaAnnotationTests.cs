using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

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
    [InlineData(GameRelease.Fallout4, "npc_", "Items", "Item.Item", "Item.Count,Data.ItemCondition,Data.Owner")]
    [InlineData(GameRelease.Fallout4, "npc_", "ObjectTemplates.[].Properties", "Property", null)]
    [InlineData(GameRelease.Fallout4, "regn", "Sounds.Sounds", "Sound", null)]
    [InlineData(GameRelease.Fallout4, "misc", "Components", null, null)]
    [InlineData(GameRelease.Fallout4, "achr", "LinkedReferences", "KeywordOrReference", null)]
    [InlineData(GameRelease.Fallout4, "refr", "LinkedReferences", null, null)]
    [InlineData(GameRelease.Fallout4, "land", "Layers", "Header.Quadrant,Header.LayerNumber", null)]
    [InlineData(GameRelease.Fallout4, "perk", "Effects", "Rank,Priority", null)]
    [InlineData(GameRelease.SkyrimSE, "lvli", "Entries", "Data.Level,Data.Reference", "Data.Count,ExtraData.ItemCondition,ExtraData.Owner")]
    [InlineData(GameRelease.Starfield, "lvli", "Entries", "Level,Reference", "Count,Data.ItemCondition,Data.Owner")]
    public void AnArrayXEditSorts_AlignsByTheKeyXEditSortsItBy_AndAnyOtherAlignsInSequence(
        GameRelease release, string table, string path, string? keys, string? extendedKeys)
    {
        var array = SchemaFields.At(release, table, path);

        Assert.Equal(keys?.Split(','), array.KeyMembers);
        Assert.Equal(extendedKeys?.Split(','), array.ExtendedKeyMembers);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4, "npc_", "Keywords", false)]
    [InlineData(GameRelease.Fallout4, "npc_", "Factions", false)]
    [InlineData(GameRelease.Fallout4, "lctn", "WorldspaceCellsAdded.[].Coordinates", false)]
    [InlineData(GameRelease.Fallout4, "npc_", "Packages", true)]
    [InlineData(GameRelease.SkyrimSE, "cobj", "Conditions", true)]
    [InlineData(GameRelease.Starfield, "scol", "Parts.[].Placements", false)]
    public void OnlyAnArrayWhoseOrderTheGameReads_TakesMove(GameRelease release, string table, string path, bool takesMove)
    {
        var array = SchemaFields.At(release, table, path);

        Assert.Equal(takesMove, array.TakesMove);
    }

    private static SchemaReflector Fallout4With(Func<SchemaAnnotations, SchemaAnnotations> overlay) =>
        new(annotationsOf: _ => overlay(GameCodecs.For(GameRelease.Fallout4).Annotations));

    public static TheoryData<Func<SchemaAnnotations, SchemaAnnotations>, string> RowsTheWalkNeverMeets => new()
    {
        {
            annotations => annotations with { UnkeyedSortedArrays = [.. annotations.UnkeyedSortedArrays, ("INpcGetter", "Unwalked")] },
            "UnkeyedSortedArrays: INpcGetter.Unwalked"
        },
        {
            annotations => annotations with { KeyedArrays = new(annotations.KeyedArrays) { [("IHeadDataGetter", "HeadParts")] = ["Number"] } },
            "KeyedArrays: IHeadDataGetter.HeadParts"
        },
    };

    [Theory]
    [MemberData(nameof(RowsTheWalkNeverMeets))]
    public void ASortedArrayRowTheWalkNeverMeets_FailsTheSchemaBuild_NamingTheRow(Func<SchemaAnnotations, SchemaAnnotations> overlay, string row)
    {
        var reflector = Fallout4With(overlay);

        var failure = Assert.Throws<InvalidOperationException>(() => reflector.GetSchemas(GameRelease.Fallout4));

        Assert.Contains(row, failure.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(typeof(INpcGetter), "npc_", false)]
    [InlineData(typeof(INpcGetter), "armo", true)]
    public void AFormatSortedList_TakesNoMove_OnlyUnderItsDeclarer(Type declarer, string table, bool takesMove)
    {
        var reflector = Fallout4With(annotations => annotations with
        {
            UnkeyedSortedArrays = [],
            FormatSortedLists = [.. annotations.FormatSortedLists, (declarer, "Keywords")],
        });

        var keywords = reflector.GetSchemas(GameRelease.Fallout4)[table].RecordColumns.Single(column => column.Name == "Keywords").Field;

        Assert.Equal(takesMove, keywords.TakesMove);
    }

    [Fact]
    public void AFormatSortedListWalkedUnderAProperBaseThatKeysIt_BuildsTheSchema_KeyedThere()
    {
        var reflector = Fallout4With(annotations => annotations with
        {
            FormatSortedLists = [.. annotations.FormatSortedLists, (typeof(IPlacedArrowGetter), "LinkedReferences")],
        });

        var linked = reflector.GetSchemas(GameRelease.Fallout4)["parw"].RecordColumns.Single(column => column.Name == "LinkedReferences").Field;

        Assert.Equal(["KeywordOrReference"], linked.KeyMembers);
    }

    [Fact]
    public void AFormatSortedListWalkedUnderAProperBaseThatLeavesItMovable_FailsTheSchemaBuild_NamingBoth()
    {
        var reflector = Fallout4With(annotations => annotations with
        {
            FormatSortedLists = [.. annotations.FormatSortedLists, (typeof(IPlacedArrowGetter), "LocationRefTypes")],
        });

        var failure = Assert.Throws<InvalidOperationException>(() => reflector.GetSchemas(GameRelease.Fallout4));

        Assert.Contains("IPlacedArrowGetter.LocationRefTypes", failure.Message, StringComparison.Ordinal);
        Assert.Contains("IAPlacedTrapGetter.LocationRefTypes", failure.Message, StringComparison.Ordinal);
    }

    private static FieldMetadata QuestAdapterMember(GameRelease release, string path) =>
        path.Split('.').Aggregate(
            SharedSchemaReflector.Instance.GetSchemas(release)["qust"].RecordColumns.Single(c => c.Name == "VirtualMachineAdapter").Field,
            (owner, name) => (owner.ElementType ?? owner).Fields.Require().Single(f => f.Name == name));

    [Theory]
    [InlineData(GameRelease.SkyrimSE, "Fragments", "Stage,StageIndex")]
    [InlineData(GameRelease.SkyrimSE, "Aliases", "Property.Object,Property.Alias")]
    [InlineData(GameRelease.Starfield, "Scripts.Properties.Structs.Members", "Name")]
    [InlineData(GameRelease.Starfield, "Aliases", "Property.Alias")]
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
