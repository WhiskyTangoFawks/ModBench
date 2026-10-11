namespace MEditService.Codec.Schema;

/// <summary>The Starfield keyed arrays outside the virtual machine adapter, overlaid on the reflected
/// schema. Its own file so <see cref="SchemaAnnotations"/> stays game-neutral.</summary>
internal static class StarfieldKeyedArrayAnnotations
{
    /// <summary>Arrays xEdit declares <c>wbArrayS</c> or <c>wbRArrayS</c> over a wbStructSK,
    /// keyed as it aligns (a wbStructExSK by its non-extended key), transcribed from
    /// <c>wbDefinitionsSF1.pas</c> and <c>wbDefinitionsCommon.pas</c>.</summary>
    public static readonly (string TypeName, string MemberName, string[] KeyMembers)[] KeyedArrays =
    [
        ("INavmeshGeometryGetter", "DoorTriangles", ["TriangleBeforeDoor", "Door"]),
        ("INavigationMeshGetter", "PreCutMapEntries", ["Reference"]),
        ("INavigationMeshInfoMapGetter", "MapInfos", ["NavigationMesh"]),
        ("INavigationMapInfoGetter", "LinkedDoors", ["Door"]),
        ("IPreferredPathingGetter", "NavmeshTree", ["NodeIndex"]),

        ("IActivatorGetter", "Properties", ["ActorValue"]),
        ("IClassGetter", "Properties", ["ActorValue"]),
        ("IContainerGetter", "Properties", ["ActorValue"]),
        ("IDoorGetter", "Properties", ["ActorValue"]),
        ("IFloraGetter", "Properties", ["ActorValue"]),
        ("IFurnitureGetter", "Properties", ["ActorValue"]),
        ("ILightGetter", "Properties", ["ActorValue"]),
        ("ILocationGetter", "Properties", ["ActorValue"]),
        ("ILocationGetter", "Properties2", ["ActorValue"]),
        ("IMoveableStaticGetter", "Properties", ["ActorValue"]),
        ("INpcGetter", "Properties", ["ActorValue"]),
        ("IPackInGetter", "Properties", ["ActorValue"]),
        ("IPlacedObjectGetter", "Properties", ["ActorValue"]),
        ("IRaceGetter", "Properties", ["ActorValue"]),
        ("IStaticGetter", "Properties", ["ActorValue"]),
        ("ITerminalGetter", "Properties", ["ActorValue"]),
        ("IPropertySheetComponentGetter", "Properties", ["ActorValue"]),
        // xEdit's key, the crowd's Actor, is the member Mutagen names ActorValue.
        ("ICrowdComponentItemGetter", "Properties", ["ActorValue"]),

        ("IArmorModificationGetter", "Properties", ["Property"]),
        ("IContainerModificationGetter", "Properties", ["Property"]),
        ("IFloraModificationGetter", "Properties", ["Property"]),
        ("INpcModificationGetter", "Properties", ["Property"]),
        ("IObjectModificationGetter", "Properties", ["Property"]),
        ("IUnknownObjectModificationGetter", "Properties", ["Property"]),
        ("IWeaponModificationGetter", "Properties", ["Property"]),
        ("IObjectTemplateGetter`1", "Properties", ["Property"]),

        ("IContainerGetter", "Items", ["Item.Item"]),
        ("IContainerComponentGetter", "Items", ["Item.Item"]),
        ("IFurnitureGetter", "ContainerItems", ["Item.Item"]),
        ("INpcGetter", "Items", ["Item.Item"]),
        ("IQuestReferenceAliasGetter", "Items", ["Item.Item"]),
        ("ILeveledBaseFormGetter", "Entries", ["Level", "Reference"]),
        ("ILeveledItemGetter", "Entries", ["Level", "Reference"]),
        ("ILeveledNpcGetter", "Entries", ["Level", "Reference"]),
        ("ILeveledPackInGetter", "Entries", ["Level", "Reference"]),
        ("ILeveledSpaceCellGetter", "Entries", ["Level", "Reference"]),
        ("ILeveledBaseFormGetter", "FilterKeywordChances", ["Keyword"]),
        ("ILeveledItemGetter", "FilterKeywordChances", ["Keyword"]),
        ("ILeveledNpcGetter", "FilterKeywordChances", ["Keyword"]),
        ("IConstructibleObjectGetter", "ConstructableComponents", ["Component"]),
        ("IConstructibleObjectGetter", "RepairComponents", ["Component"]),
        ("IConstructibleObjectGetter", "RequiredPerks", ["Perk"]),

        ("IArmorGetter", "Resistances", ["DamageType"]),
        ("IExplosionGetter", "DamageType", ["DamageType"]),
        ("IWeaponGetter", "DamageTypes", ["DamageType"]),
        ("IDestructibleGetter", "Resistances", ["DamageType"]),

        ("INpcGetter", "Factions", ["Faction"]),
        ("INpcGetter", "Perks", ["Perk"]),
        ("INpcGetter", "FaceDialPositions", ["Index"]),
        ("INpcGetter", "FaceMorphs", ["Index"]),
        ("INpcFaceMorphGetter", "MorphGroups", ["MorphGroup"]),
        ("INpcGetter", "MorphBlends", ["BlendName"]),
        ("IRaceGetter", "Attacks", ["AttackEvent"]),
        ("IRaceGetter", "MovementDataOverrides", ["MovementType"]),
        ("IFactionGetter", "Relations", ["Target"]),
        ("IFactionGetter", "Ranks", ["Number"]),
        ("IBodyPartDataGetter", "Parts", ["PartNode"]),

        ("IAPerkEffectGetter", "Conditions", ["RunOnTabIndex"]),
        ("IQuestGetter", "Stages", ["Index"]),

        ("ILocationGetter", "AddedPersistLocationReferences", ["Actor"]),
        ("ILocationGetter", "MasterPersistLocationReferences", ["Actor"]),
        ("ILocationGetter", "AddedUniqueBaseForms", ["GenericBaseForm"]),
        ("ILocationGetter", "LocationCellUniqueReferences", ["GenericBaseForm"]),
        ("ILocationGetter", "AddedUniqueNpcs", ["Ref"]),
        ("ILocationGetter", "MasterUniqueNpcs", ["Ref"]),
        // xEdit's key, its Ref, is the member Mutagen names Marker.
        ("ILocationGetter", "AddedSpecialReferences", ["Marker"]),
        ("ILocationGetter", "MasterSpecialReferences", ["Marker"]),
        ("ILocationGetter", "MasterWorldspaceCells", ["Location"]),

        ("IClimateGetter", "Weathers", ["Weather"]),
        ("IClimateGetter", "WeatherSettings", ["Settings"]),
        ("IRegionWeatherGetter", "Weathers", ["Weather"]),
        ("IImpactDataSetGetter", "Impacts", ["Material"]),
        ("ILensFlareGetter", "Sprites", ["LensFlareSpriteId"]),
        ("IStaticCollectionGetter", "Parts", ["Static"]),
        ("IAmbientSoundEventGetter", "PlanetCustomizations", ["Planet", "SwitchState"]),
        ("IBiomeProceduralObjectGenerationGetter", "Objects", ["PackIn"]),
        ("IVehicleMaterialTableGetter", "AudioRules", ["Rule"]),
        ("IVehicleMaterialTableGetter", "VfxRules", ["Rule"]),
        ("IVehicleMaterialTableGetter", "FrictionRules", ["Rule"]),
        ("IBlueprintComponentBODSRowGetter", "BODSItems", ["Name"]),
        ("IPlanetModelComponentXMPMGetter", "UnknownSubItems", ["ResourceID"]),
    ];

    /// <summary>What a wbStructExSK adds to its key. Pack-in and space cell entries carry no COED, so
    /// their extension is the count alone.</summary>
    public static readonly (string TypeName, string MemberName, string[] ExtendedKeyMembers)[] ExtendedKeys =
    [
        ("IContainerGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("IContainerComponentGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("IFurnitureGetter", "ContainerItems", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("INpcGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("IQuestReferenceAliasGetter", "Items", ["Item.Count", "Data.ItemCondition", "Data.Owner"]),
        ("ILeveledBaseFormGetter", "Entries", ["Count", "Data.ItemCondition", "Data.Owner"]),
        ("ILeveledItemGetter", "Entries", ["Count", "Data.ItemCondition", "Data.Owner"]),
        ("ILeveledNpcGetter", "Entries", ["Count", "Data.ItemCondition", "Data.Owner"]),
        ("ILeveledPackInGetter", "Entries", ["Count"]),
        ("ILeveledSpaceCellGetter", "Entries", ["Count"]),
    ];
}
