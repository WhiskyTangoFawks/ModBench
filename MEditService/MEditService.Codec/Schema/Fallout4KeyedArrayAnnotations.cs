namespace MEditService.Codec.Schema;

/// <summary>The Fallout 4 keyed arrays outside the virtual machine adapter, overlaid on the reflected
/// schema. Its own file so <see cref="SchemaAnnotations"/> stays game-neutral.</summary>
internal static class Fallout4KeyedArrayAnnotations
{
    /// <summary>Arrays xEdit declares <c>wbArrayS</c> or <c>wbRArrayS</c> over a wbStructSK,
    /// keyed as it aligns (a wbStructExSK by its non-extended key), transcribed from
    /// <c>wbDefinitionsFO4.pas</c> and <c>wbDefinitionsCommon.pas</c>.</summary>
    public static readonly (string TypeName, string MemberName, string[] KeyMembers)[] KeyedArrays =
    [
        ("ILandscapeGetter", "Layers", ["Header.Quadrant", "Header.LayerNumber"]),
        ("INavmeshGeometryGetter", "DoorTriangles", ["TriangleBeforeDoor", "Door"]),
        ("INavigationMeshGetter", "PreCutMapEntries", ["Reference"]),
        ("INavigationMeshInfoMapGetter", "MapInfos", ["NavigationMesh"]),
        ("INavigationMapInfoGetter", "LinkedDoors", ["Door"]),
        ("IPreferredPathingGetter", "NavmeshTree", ["NodeIndex"]),

        ("IAPlacedTrapGetter", "LinkedReferences", ["KeywordOrReference"]),
        ("IPlacedNpcGetter", "LinkedReferences", ["KeywordOrReference"]),
        ("IAPlacedTrapGetter", "Reflections", ["Water"]),
        ("IActivateParentsGetter", "Parents", ["Reference"]),
        ("ICellGetter", "CombinedMeshReferences", ["Reference"]),

        ("IActivatorGetter", "Properties", ["ActorValue"]),
        ("IClassGetter", "Properties", ["ActorValue"]),
        ("IContainerGetter", "Properties", ["ActorValue"]),
        ("IFloraGetter", "Properties", ["ActorValue"]),
        ("IFurnitureGetter", "Properties", ["ActorValue"]),
        ("ILightGetter", "Properties", ["ActorValue"]),
        ("IMovableStaticGetter", "Properties", ["ActorValue"]),
        ("INpcGetter", "Properties", ["ActorValue"]),
        ("IRaceGetter", "Properties", ["ActorValue"]),
        ("IStaticGetter", "Properties", ["ActorValue"]),
        ("ITerminalGetter", "Properties", ["ActorValue"]),

        ("IArmorModificationGetter", "Properties", ["Property"]),
        ("INpcModificationGetter", "Properties", ["Property"]),
        ("IObjectModificationGetter", "Properties", ["Property"]),
        ("IUnknownObjectModificationGetter", "Properties", ["Property"]),
        ("IWeaponModificationGetter", "Properties", ["Property"]),
        ("IObjectTemplateGetter`1", "Properties", ["Property"]),

        ("IContainerGetter", "Items", ["Item.Item"]),
        ("IFurnitureGetter", "Items", ["Item.Item"]),
        ("INpcGetter", "Items", ["Item.Item"]),
        ("IQuestReferenceAliasGetter", "Items", ["Item.Item"]),
        ("ILeveledItemGetter", "Entries", ["Data.Level", "Data.Reference"]),
        ("ILeveledNpcGetter", "Entries", ["Data.Level", "Data.Reference"]),
        ("ILeveledItemGetter", "FilterKeywordChances", ["FilterKeyword"]),
        ("ILeveledNpcGetter", "FilterKeywordChances", ["FilterKeyword"]),
        ("IConstructibleObjectGetter", "Components", ["Component"]),

        ("IArmorGetter", "Resistances", ["DamageType"]),
        ("IWeaponGetter", "DamageTypes", ["DamageType"]),
        ("IDestructibleGetter", "Resistances", ["DamageType"]),

        ("INpcGetter", "Factions", ["Faction"]),
        ("INpcGetter", "Perks", ["Perk"]),
        ("INpcGetter", "Attacks", ["AttackEvent"]),
        ("INpcGetter", "Sounds", ["Keyword"]),
        ("INpcGetter", "FaceMorphs", ["Index"]),
        ("INpcGetter", "FaceTintingLayers", ["Index"]),
        ("IRaceGetter", "Attacks", ["AttackEvent"]),
        ("IRaceGetter", "MovementDataOverrides", ["MovementType"]),
        ("IHeadDataGetter", "HeadParts", ["Number"]),
        ("IFactionGetter", "Relations", ["Target"]),
        ("IFactionGetter", "Ranks", ["Number"]),
        ("IBodyPartDataGetter", "Parts", ["PartNode"]),

        ("IAPerkEffectGetter", "Conditions", ["RunOnTabIndex"]),
        ("IQuestGetter", "Stages", ["Index"]),

        ("ILocationGetter", "PersistentActorReferencesAdded", ["Actor"]),
        ("ILocationGetter", "PersistentActorReferencesStatic", ["Actor"]),
        ("ILocationGetter", "UniqueActorReferencesAdded", ["Ref"]),
        ("ILocationGetter", "UniqueActorReferencesStatic", ["Ref"]),
        ("ILocationGetter", "LocationRefTypeReferencesAdded", ["Ref"]),
        ("ILocationGetter", "LocationRefTypeReferencesStatic", ["Ref"]),
        ("ILocationGetter", "WorldspaceCellsAdded", ["Location"]),
        ("ILocationGetter", "WorldspaceCellsStatic", ["Location"]),
        ("ILocationGetter", "WorldspaceCellsRemoved", ["Location"]),

        ("IClimateGetter", "Weathers", ["Weather"]),
        ("IRegionWeatherGetter", "Weathers", ["Weather"]),
        ("IRegionGrassesGetter", "Grasses", ["Grass"]),
        ("IRegionSoundsGetter", "Sounds", ["Sound"]),
        ("IImpactDataSetGetter", "Impacts", ["Material"]),
        ("IMagicEffectGetter", "Sounds", ["Type"]),
        ("ISoundDescriptorGetter", "RatesOfFire", ["RotationsPerMinute"]),
        ("ISoundKeywordMappingGetter", "Sounds", ["ReverbClass"]),
        ("ILensFlareGetter", "Sprites", ["LensFlareSpriteId"]),
        ("IMaterialSwapGetter", "Substitutions", ["OriginalMaterial"]),
        ("IStaticCollectionGetter", "Parts", ["Static"]),
    ];

    /// <summary>What a wbStructExSK adds to its key, which orders the elements sharing a key before
    /// xEdit pairs the nth across plugins. COED's owner with its global or rank is one Mutagen union.</summary>
    public static readonly (string TypeName, string MemberName, string[] ExtendedKeyMembers)[] ExtendedKeys =
    [
        ("IContainerGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("IFurnitureGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("INpcGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("IQuestReferenceAliasGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("ILeveledItemGetter", "Entries", ["Data.Count", "ExtraData.ItemCondition", "ExtraData.Owner"]),
        ("ILeveledNpcGetter", "Entries", ["Data.Count", "ExtraData.ItemCondition", "ExtraData.Owner"]),
    ];
}
