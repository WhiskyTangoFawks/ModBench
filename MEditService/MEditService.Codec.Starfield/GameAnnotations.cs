using MEditService.Codec.Schema;
using static MEditService.Codec.Schema.SchemaAnnotations;

namespace MEditService.Codec.Game;

/// <summary>The facts overlaid on the reflected schema of this game's types.</summary>
internal static class GameAnnotations
{
    private static readonly string ModHeaderGetterName = typeof(IGameModHeaderGetter).Name;

    private static readonly string MajorRecordGetterName = typeof(IStarfieldMajorRecordGetter).Name;

    public static SchemaAnnotations Table { get; } =
        new(
            ExcludedColumns: [.. GrupTimestampColumns, ("IQuestGetter", "Timestamp")],
            ExcludedMembers:
            [
                .. PlumbingMembers,
                ("IObjectModStringPropertyGetter`1", "Unused"),
                ("IObjectModEnumPropertyGetter`1", "Unused"),
                ("IConditionDataGetter", "Function"),
            ],
            ExcludedUnions: [],
            FunctionUnions: ["ConditionData"],
            UnusedSlotMembers: [.. UnusedConditionSlotCarriers, .. StarfieldConditionAnnotations.UnusedSlotMembers],
            // As in Fallout 4, no struct member is a struct.
            CycleTruncations: ["IScriptStructPropertyGetter", "IScriptStructListPropertyGetter"],
            EmptySubSchemaTypes: [.. EmptySubSchemaTypesInEveryGame],
            VectorStructTypes: [.. VectorStructTypesInEveryGame],
            RefusedShapes: new(RefusedShapesInEveryGame, StringComparer.Ordinal),
            // wbDefinitionsSF1.pas's TES4 record spells the light-master and overlay bits Small and Update.
            EnumMemberLabels: new()
            {
                [(ModHeaderGetterName, "Flags")] = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["Light"] = "Small",
                    ["Overlay"] = "Update",
                },
            },
            KnownDefects: [],
            SiblingsInUse: new Dictionary<(string, string), IReadOnlyDictionary<string, IReadOnlyList<string>>>
            {
                [("IConditionDataGetter", "RunOnType")] = RunOnAnnotations.Reference,
            },
            KeyedArrays: StarfieldVmadAnnotations.KeyedArrays.Concat(StarfieldKeyedArrayAnnotations.KeyedArrays).ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.KeyMembers),
            ExtendedKeys: StarfieldKeyedArrayAnnotations.ExtendedKeys.ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.ExtendedKeyMembers),
            PermittedNullFormLinks: [.. StarfieldVmadAnnotations.PermittedNullFormLinks],
            // xEdit's wbVec3PosRot: the Data of REFR, ACHR and the projectile placements.
            PlacedRotations: [("IPlacedObjectGetter", "Rotation"), ("IPlacedNpcGetter", "Rotation"), ("IAPlacedTrapGetter", "Rotation")],
            SyntheticFlagMembers: new()
            {
                [(ModHeaderGetterName, "IsSmallMaster")] = ("Flags", "Light"),
            },
            RecordHeaderMembers:
            [
                .. RecordHeaderMembersInEveryGame,
                new(MajorRecordGetterName, "Version2", "Version Control Info 2", IgnoredInConflicts: true),
            ],
            // Mutagen names it on Starfield's Cell, DialogTopic and Quest; wbDefinitionsSF1.pas gives WRLD bit 14 too.
            RecordFlagNames: [("IWorldspaceGetter", PartialFormFlag.Bit, PartialFormName)],
            // Static.xml and StaticCollection.xml spell their majorFlag attribute majorFlags; Key.xml,
            // Region.xml and LeveledBaseForm.xml declare none.
            RecordFlagEnums:
            [
                .. PlacedObjectRecordFlagEnums,
                ("IStaticGetter", "MajorFlag"),
                ("IStaticCollectionGetter", "MajorFlag"),
                ("IKeyGetter", "MajorFlag"),
                ("IRegionGetter", "MajorFlag"),
                ("ILeveledBaseFormGetter", "MajorFlag"),
            ],
            // The installed masters' exterior references sit in their cell's grid at 100 units a cell, and
            // wbDefinitionsSF1.pas sets wbCellSizeFactor to 100; Mutagen's 4096 scales worldspace bounds.
            ExteriorCellWidth: 100f,
            PartialFormCellsDefinedIn: null,
            DisplayNameOverrides: new Dictionary<string, string> { ["idle"] = "Animation" },
            PluginHeaderMembers: PluginHeaderMembersOf(ModHeaderGetterName),
            ContainmentMembers: [CellGridInEveryGame]);
}
