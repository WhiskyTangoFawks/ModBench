namespace MEditService.Codec.Schema;

/// <summary>The Skyrim keyed arrays outside the virtual machine adapter and conditions, overlaid on
/// the reflected schema. Its own file so <see cref="SchemaAnnotations"/> stays game-neutral.</summary>
internal static class SkyrimKeyedArrayAnnotations
{
    /// <summary>Arrays xEdit declares <c>wbArrayS</c> or <c>wbRArrayS</c> over a wbStructSK,
    /// keyed as it aligns (a wbStructExSK by its non-extended key), transcribed from
    /// <c>wbDefinitionsTES5.pas</c> and <c>wbDefinitionsCommon.pas</c>.</summary>
    public static readonly (string TypeName, string MemberName, string[] KeyMembers)[] KeyedArrays =
    [
        ("ILandscapeGetter", "Layers", ["Header.Quadrant", "Header.LayerNumber"]),
        ("IAlphaLayerGetter", "AlphaLayerData", ["Position"]),
        ("INavigationMeshDataGetter", "DoorTriangles", ["TriangleBeforeDoor", "Door"]),
        ("INavigationMeshInfoMapGetter", "MapInfos", ["NavigationMesh"]),
        ("INavigationMapInfoGetter", "LinkedDoors", ["Door"]),
        ("IPreferredPathingGetter", "NavmeshTree", ["NodeIndex"]),

        ("IAPlacedTrapGetter", "LinkedReferences", ["KeywordOrReference"]),
        ("IPlacedNpcGetter", "LinkedReferences", ["KeywordOrReference"]),
        ("IAPlacedTrapGetter", "Reflections", ["Water"]),
        ("IPlacedObjectGetter", "Reflections", ["Water"]),
        ("IActivateParentsGetter", "Parents", ["Reference"]),

        ("IModelGetter", "AlternateTextures", ["Name", "Index"]),
        ("IModelBehaviorGetter", "AlternateTextures", ["Name", "Index"]),
        ("IModelBodyTextureGetter", "AlternateTextures", ["Name", "Index"]),

        ("IConstructibleObjectGetter", "Items", ["Item.Item"]),
        ("IContainerGetter", "Items", ["Item.Item"]),
        ("INpcGetter", "Items", ["Item.Item"]),
        ("IQuestAliasGetter", "Items", ["Item.Item"]),
        ("ILeveledItemGetter", "Entries", ["Data.Level", "Data.Reference"]),
        ("ILeveledNpcGetter", "Entries", ["Data.Level", "Data.Reference"]),
        ("ILeveledSpellGetter", "Entries", ["Data.Level", "Data.Reference"]),

        ("INpcGetter", "Factions", ["Faction"]),
        ("INpcGetter", "Perks", ["Perk"]),
        ("INpcGetter", "Attacks", ["AttackEvent"]),
        ("INpcGetter", "TintLayers", ["Index"]),
        ("INpcSoundTypesGetter", "Types", ["Type"]),
        ("INpcSoundTypeGetter", "Sounds", ["Sound"]),
        ("IRaceGetter", "Attacks", ["AttackEvent"]),
        ("IRaceGetter", "MovementTypes", ["MovementType"]),
        ("IHeadDataGetter", "HeadParts", ["Number"]),
        ("IFactionGetter", "Relations", ["Target"]),
        ("IFactionGetter", "Ranks", ["Number"]),
        ("IBodyPartDataGetter", "Parts", ["PartNode"]),

        ("IAPerkEffectGetter", "Conditions", ["RunOnTabIndex"]),
        ("IQuestGetter", "Stages", ["Index"]),
        ("IQuestGetter", "Objectives", ["Index"]),

        ("ILocationGetter", "PersistentActorReferencesAdded", ["Actor"]),
        ("ILocationGetter", "PersistentActorReferencesStatic", ["Actor"]),
        ("ILocationGetter", "UniqueActorReferencesAdded", ["Ref"]),
        ("ILocationGetter", "UniqueActorReferencesStatic", ["Ref"]),
        ("ILocationGetter", "LocationRefTypeReferencesAdded", ["Ref"]),
        ("ILocationGetter", "LocationRefTypeReferencesStatic", ["Ref"]),
        ("ILocationGetter", "WorldspaceCellsAdded", ["Location"]),
        ("ILocationGetter", "WorldspaceCellsStatic", ["Location"]),
        ("ILocationGetter", "WorldspaceCellsRemoved", ["Location"]),
        // xEdit's first member, its Ref, is the one Mutagen names Actor.
        ("ILocationGetter", "EnableParentReferencesAdded", ["Actor"]),
        ("ILocationGetter", "EnableParentReferencesStatic", ["Actor"]),

        ("IClimateGetter", "WeatherTypes", ["Weather"]),
        ("IRegionWeatherGetter", "Weathers", ["Weather"]),
        ("IRegionGrassesGetter", "Grasses", ["Grass"]),
        ("IRegionSoundsGetter", "Sounds", ["Sound"]),
        ("IImpactDataSetGetter", "Impacts", ["Material"]),
        ("IMagicEffectGetter", "Sounds", ["Type"]),
    ];

    /// <summary>What a wbStructExSK adds to its key. A leveled spell's entries carry no COED, so their
    /// extension is the count alone.</summary>
    public static readonly (string TypeName, string MemberName, string[] ExtendedKeyMembers)[] ExtendedKeys =
    [
        ("IConstructibleObjectGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("IContainerGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("INpcGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("IQuestAliasGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("ILeveledItemGetter", "Entries", ["Data.Count", "ExtraData.ItemCondition", "ExtraData.Owner"]),
        ("ILeveledNpcGetter", "Entries", ["Data.Count", "ExtraData.ItemCondition", "ExtraData.Owner"]),
        ("ILeveledSpellGetter", "Entries", ["Data.Count"]),
    ];
}
