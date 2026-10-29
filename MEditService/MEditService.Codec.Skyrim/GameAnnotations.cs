using MEditService.Codec.Schema;
using static MEditService.Codec.Schema.SchemaAnnotations;

namespace MEditService.Codec.Game;

/// <summary>The facts overlaid on the reflected schema of this game's types.</summary>
internal static class GameAnnotations
{
    private static readonly string ModHeaderGetterName = typeof(IGameModHeaderGetter).Name;

    private static readonly string MajorRecordGetterName = typeof(ISkyrimMajorRecordGetter).Name;

    public static SchemaAnnotations Table { get; } =
        new(
            ExcludedColumns: [.. GrupTimestampColumns],
            ExcludedMembers:
            [
                .. PlumbingMembers,
                ("IGlobalGetter", "TypeChar"),
                ("IGlobalUnknownGetter", "TypeChar"),
                // Mutagen's untyped view over each condition function's own typed members: not record
                // data, and the abstract ConditionData's implementation throws.
                ("IConditionParametersGetter", "StringParameter1"),
                ("IConditionParametersGetter", "StringParameter2"),
                ("IConditionParametersGetter", "Parameter1"),
                ("IConditionParametersGetter", "Parameter2"),
                ("IConditionParametersGetter", "Parameter1Type"),
                ("IConditionParametersGetter", "Parameter2Type"),
                // Mutagen's answer to which function a leaf is: the document never holds it, since the
                // leaf's class names the function, and GetEventData's own Function is another member.
                ("IConditionDataGetter", "Function"),
            ],
            ExcludedUnions: [],
            FunctionUnions: ["ConditionData"],
            UnusedSlotMembers: [.. UnusedConditionSlotCarriers, ("ConditionData", "Unused")],
            CycleTruncations: [],
            EmptySubSchemaTypes: [.. EmptySubSchemaTypesInEveryGame],
            VectorStructTypes: [.. VectorStructTypesInEveryGame, "Noggog.P3UInt8", "Noggog.P3UInt16"],
            RefusedShapes: new(RefusedShapesInEveryGame, StringComparer.Ordinal),
            EnumMemberLabels: new()
            {
                [(ModHeaderGetterName, "Flags")] = XEditModHeaderFlagNames,
            },
            KnownDefects: [],
            SiblingsInUse: new Dictionary<(string, string), IReadOnlyDictionary<string, IReadOnlyList<string>>>
            {
                [("IConditionDataGetter", "RunOnType")] = RunOnAnnotations.Reference,
            },
            KeyedArrays: SkyrimVmadAnnotations.KeyedArrays.Concat(SkyrimKeyedArrayAnnotations.KeyedArrays).ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.KeyMembers),
            ExtendedKeys: SkyrimKeyedArrayAnnotations.ExtendedKeys.ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.ExtendedKeyMembers),
            PermittedNullFormLinks: [.. SkyrimVmadAnnotations.PermittedNullFormLinks],
            // xEdit's wbVec3PosRot: which Mutagen's Placement holds here.
            PlacedRotations: [("IPlacementGetter", "Rotation")],
            SyntheticFlagMembers: new()
            {
                [(ModHeaderGetterName, "IsSmallMaster")] = ("Flags", "Small"),
            },
            RecordHeaderMembers:
            [
                .. RecordHeaderMembersInEveryGame,
                new(MajorRecordGetterName, "Version2", "Version Control Info 2", IgnoredInConflicts: true),
            ],
            // Mutagen names bit 14 on no Skyrim type; wbDefinitionsTES5.pas gives it to CELL, DIAL and WRLD.
            RecordFlagNames:
            [
                ("ICellGetter", PartialFormFlag.Bit, PartialFormName),
                ("IDialogTopicGetter", PartialFormFlag.Bit, PartialFormName),
                ("IWorldspaceGetter", PartialFormFlag.Bit, PartialFormName),
            ],
            RecordFlagEnums: [.. PlacedObjectRecordFlagEnums],
            // Mutagen's Skyrim containing-cell lookup divides by it.
            ExteriorCellWidth: 4096f,
            PartialFormCellsDefinedIn: null,
            DisplayNameOverrides: new Dictionary<string, string>(),
            PluginHeaderMembers: PluginHeaderMembersOf(ModHeaderGetterName),
            ContainmentMembers: [CellGridInEveryGame],
            // UESP's Skyrim NPC_ page, ACBS Template Data Flags.
            ActorTemplates: new("INpcGetter", "Configuration.TemplateFlags", "Template", new Dictionary<string, string>(), FlagOfMember(
            [
                ("Traits",
                [
                    "Destructible", "Race", "WornArmor", "FarAwayModel", "Height", "Weight", "Voice", "DeathItem", "SoundLevel", "Sound",
                    "HeadParts", "HairColor", "HeadTexture", "TextureLighting", "FaceMorph", "FaceParts", "TintLayers",
                ]),
                ("Stats",
                [
                    "Configuration.MagickaOffset", "Configuration.StaminaOffset", "Configuration.Level", "Configuration.CalcMinLevel",
                    "Configuration.CalcMaxLevel", "Configuration.SpeedMultiplier", "Configuration.HealthOffset",
                    "Configuration.BleedoutOverride", "Class", "PlayerSkills.SkillValues", "PlayerSkills.SkillOffsets",
                    "PlayerSkills.Health", "PlayerSkills.Magicka", "PlayerSkills.Stamina",
                ]),
                ("Factions", ["Factions", "CrimeFaction"]),
                ("SpellList", ["ActorEffect", "Perks"]),
                ("AIData", ["AIData", "CombatStyle", "GiftFilter"]),
                ("AIPackages", ["Packages"]),
                ("BaseData", ["Name", "ShortName"]),
                ("Inventory", ["Items", "DefaultOutfit", "SleepingOutfit", "PlayerSkills.GearedUpWeapons"]),
                ("Script", ["VirtualMachineAdapter"]),
                ("DefPackList",
                [
                    "DefaultPackageList", "SpectatorOverridePackageList", "ObserveDeadBodyOverridePackageList",
                    "GuardWarnOverridePackageList", "CombatOverridePackageList",
                ]),
                ("AttackData", ["AttackRace", "Attacks"]),
                ("Keywords", ["Keywords"]),
            ])));
}
