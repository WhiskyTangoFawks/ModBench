using MEditService.Codec.Schema;
using static MEditService.Codec.Schema.SchemaAnnotations;

namespace MEditService.Codec.Game;

/// <summary>The facts overlaid on the reflected schema of this game's types.</summary>
internal static class GameAnnotations
{
    private static readonly string ModHeaderGetterName = typeof(IGameModHeaderGetter).Name;

    private static readonly string MajorRecordGetterName = typeof(IFallout4MajorRecordGetter).Name;

    public static SchemaAnnotations Table { get; } =
        new(
            ExcludedColumns: [.. GrupTimestampColumns, ("IQuestGetter", "Timestamp")],
            ExcludedMembers:
            [
                .. PlumbingMembers,
                ("IGlobalGetter", "TypeChar"),  // GLOB's derived subclass discriminant char
                // Reserved padding Mutagen names Unused; wbUnused(3)/wbUnused(2) in wbDefinitionsFO4.pas's wbObjectModProperties
                ("IObjectModStringPropertyGetter`1", "Unused"),
                ("IObjectModEnumPropertyGetter`1", "Unused"),
            ],
            ExcludedUnions:
            [
                // A concrete base with two leaves, one of whose binary-overlay Type getter is an
                // unimplemented throw upstream; the member it sits on is a KnownDefects row below.
                "ASceneActionType",
            ],
            FunctionUnions: [],
            UnusedSlotMembers: [],
            CycleTruncations: ["IScriptStructPropertyGetter", "IScriptStructListPropertyGetter"],
            EmptySubSchemaTypes:
            [
                .. EmptySubSchemaTypesInEveryGame,
                "IASceneActionTypeGetter",      // deliberately not abstract upstream; see KnownDefects
            ],
            VectorStructTypes: [.. VectorStructTypesInEveryGame, "Noggog.P3UInt8", "Noggog.P3UInt16", "Noggog.P2UInt8"],
            RefusedShapes: new(RefusedShapesInEveryGame, StringComparer.Ordinal),
            EnumMemberLabels: new()
            {
                [(ModHeaderGetterName, "Flags")] = XEditModHeaderFlagNames,
            },
            KnownDefects:
            [
                new("ISceneActionGetter", "Type", KnownDefectEffect.MemberReadOnly,
                    "SceneActionTypicalType's binary-overlay Type getter is an unimplemented throw upstream, so the "
                    + "leaves under ASceneActionType cannot be read; the member is named as the document holds it and never written"),
            ],
            SiblingsInUse: new Dictionary<(string, string), IReadOnlyDictionary<string, IReadOnlyList<string>>>
            {
                [("IFunctionConditionDataGetter", "Function")] = Fallout4ConditionAnnotations.FunctionParameterSlots,
                [("IConditionDataGetter", "RunOnType")] = RunOnAnnotations.Reference,
            },
            KeyedArrays: Fallout4VmadAnnotations.KeyedArrays.Concat(Fallout4KeyedArrayAnnotations.KeyedArrays).ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.KeyMembers),
            ExtendedKeys: Fallout4KeyedArrayAnnotations.ExtendedKeys.ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.ExtendedKeyMembers),
            PermittedNullFormLinks: [.. Fallout4VmadAnnotations.PermittedNullFormLinks],
            // xEdit's wbVec3PosRot: the Data of REFR, ACHR and the projectile placements.
            PlacedRotations: [("IPlacedObjectGetter", "Rotation"), ("IPlacedNpcGetter", "Rotation"), ("IAPlacedTrapGetter", "Rotation")],
            SyntheticFlagMembers: new()
            {
                [(ModHeaderGetterName, "IsSmallMaster")] = ("Flags", "Small"),
            },
            RecordHeaderMembers:
            [
                .. RecordHeaderMembersInEveryGame,
                new(MajorRecordGetterName, "Version2", "Version Control Info 2", IgnoredInConflicts: true),
            ],
            // Quest's MajorFlag names it; wbDefinitionsFO4.pas gives CELL, DIAL and WRLD bit 14 too.
            RecordFlagNames:
            [
                ("ICellGetter", PartialFormFlag.Bit, PartialFormName),
                ("IDialogTopicGetter", PartialFormFlag.Bit, PartialFormName),
                ("IWorldspaceGetter", PartialFormFlag.Bit, PartialFormName),
            ],
            // Static.xml spells its majorFlag attribute majorFlags, so no member carries Static.MajorFlag.
            RecordFlagEnums: [.. PlacedObjectRecordFlagEnums, ("IStaticGetter", "MajorFlag")],
            // Mutagen's Fallout 4 worldspace bounds divide by it.
            ExteriorCellWidth: 4096f,
            PartialFormCellsDefinedIn: "Fallout4.esm",
            DisplayNameOverrides: new Dictionary<string, string>(),
            PluginHeaderMembers: PluginHeaderMembersOf(ModHeaderGetterName),
            ContainmentMembers: [CellGridInEveryGame]);
}
