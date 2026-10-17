using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using static MEditService.Codec.Schema.SchemaAnnotations;

namespace MEditService.Codec.Game;

/// <summary>The facts overlaid on the reflected schema of this game's types.</summary>
internal static class GameAnnotations
{
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
                [(ModHeaderGetter(GameCategory.Starfield), "Flags")] = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["Light"] = "Small",
                    ["Overlay"] = "Update",
                },
            },
            KnownDefects: [],
            SiblingsInUse: GameSpecifics.SiblingsInUse,
            KeyedArrays: StarfieldVmadAnnotations.KeyedArrays.Concat(StarfieldKeyedArrayAnnotations.KeyedArrays).ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.KeyMembers),
            ExtendedKeys: StarfieldKeyedArrayAnnotations.ExtendedKeys.ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.ExtendedKeyMembers),
            PermittedNullFormLinks: [.. StarfieldVmadAnnotations.PermittedNullFormLinks],
            SyntheticFlagMembers: new()
            {
                [(ModHeaderGetter(GameCategory.Starfield), "IsSmallMaster")] = ("Flags", "Light"),
            },
            RecordHeaderMembers:
            [
                .. RecordHeaderMembersInEveryGame,
                new(MajorRecordGetter(GameCategory.Starfield), "Version2", "Version Control Info 2", IgnoredInConflicts: true),
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
            PluginHeaderMembers: PluginHeaderMembersOf(ModHeaderGetter(GameCategory.Starfield)),
            ContainmentMembers: [CellGridInEveryGame]);
}
