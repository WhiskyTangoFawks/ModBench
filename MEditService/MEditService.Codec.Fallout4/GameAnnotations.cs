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
                ("IGlobalGetter", "TypeChar"),  // GLOB's derived subclass discriminant char
                // Reserved padding Mutagen names Unused in both games; wbUnused(3)/wbUnused(2) in wbDefinitionsFO4.pas's wbObjectModProperties
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
                [(ModHeaderGetter(GameCategory.Fallout4), "Flags")] = XEditModHeaderFlagNames,
            },
            KnownDefects:
            [
                new("ISceneActionGetter", "Type", KnownDefectEffect.MemberReadOnly,
                    "SceneActionTypicalType's binary-overlay Type getter is an unimplemented throw upstream, so the "
                    + "leaves under ASceneActionType cannot be read; the member is named as the document holds it and never written"),
            ],
            SiblingsInUse: GameSpecifics.SiblingsInUse,
            KeyedArrays: Fallout4VmadAnnotations.KeyedArrays.Concat(Fallout4KeyedArrayAnnotations.KeyedArrays).ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.KeyMembers),
            ExtendedKeys: Fallout4KeyedArrayAnnotations.ExtendedKeys.ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.ExtendedKeyMembers),
            PermittedNullFormLinks: [.. Fallout4VmadAnnotations.PermittedNullFormLinks],
            SyntheticFlagMembers: new()
            {
                [(ModHeaderGetter(GameCategory.Fallout4), "IsSmallMaster")] = ("Flags", "Small"),
            },
            RecordHeaderMembers:
            [
                .. RecordHeaderMembersInEveryGame,
                new(MajorRecordGetter(GameCategory.Fallout4), "Version2", "Version Control Info 2", IgnoredInConflicts: true),
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
            PluginHeaderMembers: PluginHeaderMembersOf(ModHeaderGetter(GameCategory.Fallout4)),
            ContainmentMembers: [CellGridInEveryGame]);
}
