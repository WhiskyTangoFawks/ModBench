using System.Reflection;
using Mutagen.Bethesda;

namespace MEditService.Core.Schema;

/// <summary>What one known Mutagen defect does to the schema and to a gesture: the member it is
/// keyed to, and the reason the user is shown.</summary>
internal sealed record KnownDefect(string TypeName, string MemberName, KnownDefectEffect Effect, string Reason);

internal enum KnownDefectEffect
{
    /// <summary>The schema names the member and carries the reason; the write path refuses any
    /// path reaching it.</summary>
    MemberReadOnly,

    /// <summary>Mutagen's generated <c>RemapLinks</c> does not walk the member, so a renumber whose
    /// links pass through it is refused rather than written half-remapped.</summary>
    RenumberRemapIncomplete,
}

/// <summary>Hand-written per-game facts overlaid on reflection, keyed by Mutagen type and member
/// name. <see cref="Validate"/> fails schema generation naming any row the assembly does not bear
/// out.</summary>
internal sealed record SchemaAnnotations(
    // GRUP signatures the schema builds no table for, and why: data the editor has no surface for,
    // and xEdit's REFR-flavour placement variants this repo collapses into refr.
    Dictionary<string, string> ExcludedSignatures,
    // Top-level properties that are not record data: GRUP timestamps. The serializer still writes
    // them (ADR-0042); a reflected column and a source-document field are different promises.
    HashSet<(string TypeName, string MemberName)> ExcludedColumns,
    // Skipped at every depth: Loqui plumbing and reserved padding. Keyed on the declaring type
    // because some names are real data elsewhere (Type is a genuine enum on Keyword).
    HashSet<(string TypeName, string MemberName)> ExcludedMembers,
    // Loqui bases the union-leaf expansion must not model: presented by a dedicated section instead,
    // or their leaves cannot be read safely. A struct column deriving from one is not a column either.
    HashSet<string> ExcludedUnions,
    // Getter interfaces the walk may re-enter and stop at silently because the game's format cannot
    // nest them (a Fallout 4 Papyrus struct member is never itself a struct). Any other re-entry is fatal.
    HashSet<string> CycleTruncations,
    // Sub-schemas known to come out empty.
    HashSet<string> EmptySubSchemaTypes,
    // The small structs the codec spells as one comma-joined text leaf, by CLR full name. A closed
    // set: an "any struct with X/Y/Z" rule would recurse through their own Point property.
    HashSet<string> VectorStructTypes,
    // Shapes the walk reaches and could present, but nobody has decided a presentation for, by CLR
    // name (a generic by its definition's). Each reason says what a future ticket would decide.
    Dictionary<string, string> RefusedShapes,
    // xEdit's own name for an enum member the document spells with Mutagen's (ADR-0034). A label,
    // never a value: the document is the model, so nothing here changes what is written.
    Dictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, string>> EnumMemberLabels,
    // Upstream Mutagen defects, each with an effect the schema and the write path honour. A defect
    // identified only by an exception message is a plugin diagnosis, not a row here.
    IReadOnlyList<KnownDefect> KnownDefects,
    // See FieldMetadata.SiblingsInUse. The inner map must name every enum value, since an unnamed one
    // would silently idle every member the row governs; validated in all four directions.
    Dictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>> SiblingsInUse,
    // xEdit's wbArrayS: elements identified by key members (Mutagen member names, dotted one struct
    // down), not by position. Aligned by key in the compare grid, written back in key order, duplicates refused.
    Dictionary<(string TypeName, string MemberName), IReadOnlyList<string>> KeyedArrays,
    // FormLinks Mutagen types non-nullable that the game's format leaves unset as a matter of course,
    // so an unset one is a value, not a dangling reference. The CLR type cannot answer this.
    HashSet<(string TypeName, string MemberName)> PermittedNullFormLinks,
    // The Color fields xEdit renders with an Alpha leaf (wbByteRGBA). A property of the field, not
    // the type, and every row is one Mutagen also writes the alpha byte for, so no alpha edit is lost.
    HashSet<(string TypeName, string MemberName)> AlphaBearingColorFields,
    // Members the document never spells but one bit of a flags member says: the ESL flag, the
    // Partial Form bit. Flag names the backing enum's member, or the bit in hex for a raw integer.
    Dictionary<(string TypeName, string MemberName), (string BackingMember, string Flag)> SyntheticFlagMembers)
{
    // Rows every game shares are named once here; a row true of only some games is written inline
    // in each table that has it, so each table still states that game's complete facts.

    private static readonly (string, string)[] GrupTimestampColumns =
    [
        ("ICellGetter", "Timestamp"), ("ICellGetter", "PersistentTimestamp"), ("ICellGetter", "TemporaryTimestamp"),
        ("IDialogTopicGetter", "Timestamp"),
    ];

    // Placed refr/achr are indexed as normal records with cell parentage in the placement side table
    // (ADR-0023); landscape and navmesh data get no such treatment.
    private const string NoEditorSurface = "no editor surface: landscape and navmesh data are record fields in no game";

    // Rare REFR-flavour placement types: projectile, hazard and the rest of xEdit's variants.
    private const string CollapsedIntoRefr = "an xEdit REFR-flavour placement variant, collapsed into refr rather than given its own table";

    private static readonly KeyValuePair<string, string>[] ExcludedSignaturesInEveryGame =
    [
        .. new[] { "land", "navm", "navi" }.Select(s => KeyValuePair.Create(s, NoEditorSurface)),
        .. new[] { "pgre", "pmis", "parw", "pbar", "pbea", "pcon", "pfla", "phzd" }
            .Select(s => KeyValuePair.Create(s, CollapsedIntoRefr)),
    ];

    // Not editor surface in any game: Mutagen.Bethesda.Core / Loqui plumbing, and one generated alias.
    private static readonly (string, string)[] PlumbingMembers =
    [
        ("ILoquiObject", "Registration"),                    // Loqui's own registration handle
        ("IBinaryItem", "BinaryWriteTranslator"),            // Mutagen's binary write-strategy object
        ("ILinkIdentifier", "Type"),                         // a System.Type, not a record field
        ("IFormKeyGetter", "FormKey"),                       // record identity, the header's own column
        ("IAMagicEffectArchetypeGetter", "AssociationKey"),  // IFormLinkIdentifier alias of Association
    ];

    private static readonly string[] EmptySubSchemaTypesInEveryGame =
    [
        "IPlacedGetter",                     // abstract placed-record base, no members of its own
    ];

    // The siblings left out (P2Double, P3Double, P3Int, the wrapper types) are the shape of no
    // member in these games' record graphs, which is what the validation below proves.
    private static readonly string[] VectorStructTypesInEveryGame =
    [
        "Noggog.P3Int16", "Noggog.P3Float",
        "Noggog.P2Int", "Noggog.P2UInt8", "Noggog.P2Int16",
        "Noggog.P3UInt8", "Noggog.P3UInt16", "Noggog.P2Float",
    ];

    // Counts are live, from the audit's enumeration over Fallout 4.
    private static readonly KeyValuePair<string, string>[] RefusedShapesInEveryGame =
    [
        // Real modding content: Race height, head data, models and voices per sex, ArmorAddon models,
        // faction rank titles. Presenting a gendered pair is a maintainer's shape decision.
        KeyValuePair.Create("IGenderedItemGetter`1",
            "gendered Male/Female pair — 20 fields; real data, deferred pending a presentation decision"),
        // Only a byte slice has a hex reading, and ByteSliceHex classifies one as a leaf long before
        // this table is asked.
        KeyValuePair.Create("ReadOnlyMemorySlice`1",
            "non-byte element slice — 2 fields; an array of typed elements, not a hex blob"),
        // LandscapeVertexHeightMap-style grids. Real data, tiny population, no grid shape.
        KeyValuePair.Create("IReadOnlyArray2d`1", "2D array grid — 4 fields; no grid presentation exists"),
        // Race.BipedObjects (keyed by BipedObject) and Package.Data (keyed by SByte). Real data; a
        // keyed map is a shape neither the schema's array nor its struct model covers.
        KeyValuePair.Create("IReadOnlyDictionary`2",
            "keyed map — 2 fields; neither the array nor the struct model covers a dictionary"),
        // Candidate atomic values, each a new rendered leaf: Percent is a raw float in xEdit,
        // TimeOnly a byte in 10-minute increments, RecordType a 4-character signature.
        KeyValuePair.Create("Percent", "Noggog Percent — 25 fields; candidate atomic value, presentation undecided"),
        KeyValuePair.Create("TimeOnly", "TimeOnly — 4 fields; candidate atomic value, presentation undecided"),
        KeyValuePair.Create("RecordType",
            "Mutagen RecordType signature — 7 fields; candidate atomic value, presentation undecided"),
    ];

    // wbByteRGBA at KYWD, LCRT, AACT and LCTN in wbDefinitionsFO4.pas, likewise in Skyrim and
    // Starfield, and ColorBinaryType.Alpha on the Mutagen side.
    private static readonly (string, string)[] RgbaColorFields =
    [
        ("IKeywordGetter", "Color"),
        ("ILocationReferenceTypeGetter", "Color"),
        ("IActionRecordGetter", "Color"),
        ("ILocationGetter", "Color"),
    ];

    // wbFileHeader in wbDefinitionsFO4.pas spells the master and light-master bits ESM and ESL.
    // Localized is already xEdit's own spelling, so it carries no label.
    private static readonly Dictionary<string, string> XEditModHeaderFlagNames = new(StringComparer.Ordinal)
    {
        ["Master"] = "ESM",
        ["Small"] = "ESL",
    };

    private static readonly Dictionary<GameCategory, SchemaAnnotations> Tables = new()
    {
        [GameCategory.Fallout4] = new(
            ExcludedSignatures: new(ExcludedSignaturesInEveryGame, StringComparer.OrdinalIgnoreCase),
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
            CycleTruncations: ["IScriptStructPropertyGetter", "IScriptStructListPropertyGetter"],
            EmptySubSchemaTypes:
            [
                .. EmptySubSchemaTypesInEveryGame,
                "IASceneActionTypeGetter",      // deliberately not abstract upstream; see KnownDefects
            ],
            VectorStructTypes: [.. VectorStructTypesInEveryGame],
            RefusedShapes: new(RefusedShapesInEveryGame, StringComparer.Ordinal),
            EnumMemberLabels: new()
            {
                [("IFallout4ModHeaderGetter", "Flags")] = XEditModHeaderFlagNames,
            },
            KnownDefects:
            [
                new("ISceneActionGetter", "Type", KnownDefectEffect.MemberReadOnly,
                    "SceneActionTypicalType's binary-overlay Type getter is an unimplemented throw upstream, so the "
                    + "leaves under ASceneActionType cannot be read; the member is named as the document holds it and never written"),
                new("IScriptStructListPropertyGetter", "Structs", KnownDefectEffect.RenumberRemapIncomplete,
                    "Mutagen's generated RemapLinks does not descend into ScriptStructListProperty.Structs, so a link "
                    + "held there survives a renumber and would be left dangling"),
            ],
            SiblingsInUse: new()
            {
                [("IFunctionConditionDataGetter", "Function")] = Fallout4ConditionAnnotations.FunctionParameterSlots,
                [("IConditionDataGetter", "RunOnType")] = Fallout4ConditionAnnotations.RunOnReference,
            },
            KeyedArrays: Fallout4VmadAnnotations.KeyedArrays.ToDictionary(
                r => (r.TypeName, r.MemberName), r => (IReadOnlyList<string>)r.KeyMembers),
            PermittedNullFormLinks: [.. Fallout4VmadAnnotations.PermittedNullFormLinks],
            AlphaBearingColorFields: [.. RgbaColorFields],
            SyntheticFlagMembers: new()
            {
                [("IFallout4ModHeaderGetter", "IsSmallMaster")] = ("Flags", "Small"),
                [("ICellGetter", "IsPartialForm")] = ("MajorRecordFlagsRaw", PartialFormFlag.BitHex),
                [("IWorldspaceGetter", "IsPartialForm")] = ("MajorRecordFlagsRaw", PartialFormFlag.BitHex),
                [("IQuestGetter", "IsPartialForm")] = ("MajorRecordFlagsRaw", PartialFormFlag.BitHex),
                [("IDialogTopicGetter", "IsPartialForm")] = ("MajorRecordFlagsRaw", PartialFormFlag.BitHex),
            }),

        [GameCategory.Skyrim] = new(
            ExcludedSignatures: new(ExcludedSignaturesInEveryGame, StringComparer.OrdinalIgnoreCase),
            ExcludedColumns: [.. GrupTimestampColumns],
            ExcludedMembers: [.. PlumbingMembers, ("IGlobalGetter", "TypeChar")],
            ExcludedUnions: [],
            CycleTruncations: [],
            EmptySubSchemaTypes: [.. EmptySubSchemaTypesInEveryGame],
            VectorStructTypes: [.. VectorStructTypesInEveryGame],
            RefusedShapes: new(RefusedShapesInEveryGame, StringComparer.Ordinal),
            // This repo builds no Skyrim schema, so a label, defect, condition or keyed-array row
            // written here could not be validated against the assembly it describes. Empty until one
            // can be built.
            EnumMemberLabels: [],
            KnownDefects: [],
            SiblingsInUse: [],
            KeyedArrays: [],
            PermittedNullFormLinks: [],
            AlphaBearingColorFields: [.. RgbaColorFields],
            SyntheticFlagMembers: []),

        [GameCategory.Starfield] = new(
            ExcludedSignatures: new(ExcludedSignaturesInEveryGame, StringComparer.OrdinalIgnoreCase),
            ExcludedColumns: [.. GrupTimestampColumns, ("IQuestGetter", "Timestamp")],
            ExcludedMembers:
            [
                .. PlumbingMembers,
                ("IObjectModStringPropertyGetter`1", "Unused"),
                ("IObjectModEnumPropertyGetter`1", "Unused"),
            ],
            ExcludedUnions: [],
            // Starfield's VirtualMachineAdapter.xml declares the same struct-property chain as
            // Fallout 4's, unverified against a built Starfield schema. Empty is loud, not wrong: a
            // lifted VMAD exclusion fails generation naming the chain rather than truncating silently.
            CycleTruncations: [],
            EmptySubSchemaTypes: [.. EmptySubSchemaTypesInEveryGame],
            VectorStructTypes: [.. VectorStructTypesInEveryGame],
            RefusedShapes: new(RefusedShapesInEveryGame, StringComparer.Ordinal),
            // Empty for the same reason as Skyrim's above.
            EnumMemberLabels: [],
            KnownDefects: [],
            SiblingsInUse: [],
            KeyedArrays: [],
            PermittedNullFormLinks: [],
            AlphaBearingColorFields: [.. RgbaColorFields],
            SyntheticFlagMembers: []),
    };

    /// <summary>A game with no table is a game nobody has written the facts for — loud, not empty.</summary>
    public static SchemaAnnotations For(GameCategory category) =>
        Tables.TryGetValue(category, out var annotations)
            ? annotations
            : throw new InvalidOperationException($"No schema annotation table for {category}");

    public bool IsExcludedColumn(PropertyInfo prop) => ExcludedColumns.Contains(Key(prop));
    public bool IsExcludedMember(PropertyInfo prop) => ExcludedMembers.Contains(Key(prop));
    public bool IsExcludedUnion(Type setterType)
    {
        for (var t = setterType; t != null; t = t.BaseType)
            if (ExcludedUnions.Contains(t.Name)) return true;
        return false;
    }
    public bool IsCycleTruncation(Type getterInterface) => CycleTruncations.Contains(getterInterface.Name);
    public bool IsEmptySubSchemaType(Type getterInterface) => EmptySubSchemaTypes.Contains(getterInterface.Name);
    public bool IsVectorStructType(Type type) => VectorStructTypes.Contains(type.FullName ?? type.Name);
    public string? RefusedShapeReason(Type shape) => RefusedShapes.GetValueOrDefault(ShapeName(shape));
    public bool HasAlphaLeaf(PropertyInfo prop) => AlphaBearingColorFields.Contains(Key(prop));
    public bool IsPermittedNullFormLink(PropertyInfo prop) => PermittedNullFormLinks.Contains(Key(prop));
    public IReadOnlyDictionary<string, string>? EnumLabelsFor(PropertyInfo prop) =>
        EnumMemberLabels.GetValueOrDefault(Key(prop));
    public IReadOnlyDictionary<string, IReadOnlyList<string>>? SiblingsInUseFor(PropertyInfo prop) =>
        SiblingsInUse.GetValueOrDefault(Key(prop));
    public IReadOnlyList<string>? KeyMembersFor(PropertyInfo prop) => KeyedArrays.GetValueOrDefault(Key(prop));

    /// <summary>The defect keyed to this member, or null: a member with no row is an ordinary one.</summary>
    public KnownDefect? DefectFor(PropertyInfo prop) =>
        KnownDefects.FirstOrDefault(d => d.TypeName == prop.DeclaringType!.Name && d.MemberName == prop.Name);

    /// <summary>Why a defect keeps this member out of every write, or null.</summary>
    public string? ReadOnlyReasonFor(PropertyInfo prop) =>
        DefectFor(prop) is { Effect: KnownDefectEffect.MemberReadOnly } defect ? defect.Reason : null;

    /// <summary>Every defect with one effect, for the gesture that has to honour it.</summary>
    public IReadOnlyList<KnownDefect> DefectsWith(KnownDefectEffect effect) =>
        [.. KnownDefects.Where(d => d.Effect == effect)];

    /// <summary>The bit a synthetic member's row spells in hex, for a backing member no enum names.</summary>
    internal static long ParseBit(string flag) =>
        TryParseBit(flag, out var bit) ? bit : throw new ArgumentException($"'{flag}' is not a hex bit.", nameof(flag));

    internal static bool TryParseBit(string flag, out long bit)
    {
        bit = 0;
        return flag.StartsWith("0x", StringComparison.Ordinal)
            && long.TryParse(flag.AsSpan(2), System.Globalization.NumberStyles.HexNumber, null, out bit);
    }

    public IEnumerable<(string Name, string BackingMember, string Flag)> SyntheticFlagMembersFor(Type getterType) =>
        SyntheticFlagMembers
            .Where(e => e.Key.TypeName == getterType.Name)
            .Select(e => (e.Key.MemberName, e.Value.BackingMember, e.Value.Flag));

    private static (string, string) Key(PropertyInfo prop) => (prop.DeclaringType!.Name, prop.Name);

    // A generic by its definition's name, so one row reaches every closing of one open generic.
    private static string ShapeName(Type shape) =>
        (shape.IsGenericType ? shape.GetGenericTypeDefinition() : shape).Name;

    // A row naming a value or sibling the assembly lacks would silently govern nothing; one omitting
    // a value would silently idle everything under it.
    private IEnumerable<string> UnresolvedSiblingRelations(ILookup<string, Type> typesByName)
    {
        foreach (var (entry, byValue) in SiblingsInUse)
        {
            var declaring = typesByName[entry.TypeName]
                .FirstOrDefault(t => t.GetProperty(entry.MemberName) != null);
            if (declaring == null) continue;

            var enumType = Nullable.GetUnderlyingType(declaring.GetProperty(entry.MemberName)!.PropertyType)
                ?? declaring.GetProperty(entry.MemberName)!.PropertyType;
            var label = $"{nameof(SiblingsInUse)}: {entry.TypeName}.{entry.MemberName}";
            if (!enumType.IsEnum)
            {
                yield return $"{label} governs from a non-enum member ({enumType.Name})";
                continue;
            }

            var values = Enum.GetNames(enumType).ToHashSet(StringComparer.Ordinal);
            var members = ReflectedTypes.GetAllInterfaceProperties(declaring)
                .Select(p => p.Name)
                .ToHashSet(StringComparer.Ordinal);

            foreach (var value in byValue.Keys.Where(v => !values.Contains(v)).Order(StringComparer.Ordinal))
                yield return $"{label} names value {value}, which {enumType.Name} does not have";
            // The other direction, and it is the one that fails quietly: an unnamed value reads as
            // "no sibling in use", which idles every member this row governs.
            foreach (var value in values.Where(v => !byValue.ContainsKey(v)).Order(StringComparer.Ordinal))
                yield return $"{label} does not name value {value}, which {enumType.Name} has";
            foreach (var sibling in byValue.Values.SelectMany(v => v).Distinct().Where(m => !members.Contains(m)).Order(StringComparer.Ordinal))
                yield return $"{label} names sibling {sibling}, which {entry.TypeName} does not declare";
        }
    }

    // A row naming a key the element lacks would key every element alike, collapsing the array to
    // one row in the compare grid and refusing every second element as a duplicate.
    private IEnumerable<string> UnresolvedKeyMembers(ILookup<string, Type> typesByName)
    {
        foreach (var (entry, keyMembers) in KeyedArrays)
        {
            var declaring = typesByName[entry.TypeName].FirstOrDefault(t => t.GetProperty(entry.MemberName) != null);
            if (declaring == null) continue;

            var label = $"{nameof(KeyedArrays)}: {entry.TypeName}.{entry.MemberName}";
            if (!ReflectedTypes.IsListType(declaring.GetProperty(entry.MemberName)!.PropertyType, out var elementType))
            {
                yield return $"{label} is not a list";
                continue;
            }

            foreach (var keyPath in keyMembers)
            {
                if (UnresolvedKeyPath(elementType, keyPath) is { } why) yield return $"{label} {why}";
            }
        }
    }

    private static string? UnresolvedKeyPath(Type elementType, string keyPath)
    {
        var owner = elementType;
        var segments = keyPath.Split('.');
        for (var i = 0; i < segments.Length; i++)
        {
            var prop = ReflectedTypes.GetAllInterfaceProperties(owner)
                .FirstOrDefault(p => p.Name.Equals(segments[i], StringComparison.Ordinal));
            if (prop == null) return $"names key {keyPath}, which {owner.Name} does not reach at {segments[i]}";
            if (i == segments.Length - 1)
            {
                return ReflectedTypes.IsListType(prop.PropertyType, out _)
                    ? $"names key {keyPath}, which is itself a list — a key is one value per element"
                    : null;
            }

            if (!ReflectedTypes.IsLoquiInterface(prop.PropertyType))
                return $"names key {keyPath}, whose {segments[i]} hop is not a struct to descend into";
            owner = prop.PropertyType;
        }
        return null;
    }

    // A row backs onto a member the type reaches, and its flag is a name that enum defines or a hex
    // bit where the member is a raw integer.
    private IEnumerable<string> UnresolvedSyntheticFlags(ILookup<string, Type> typesByName)
    {
        foreach (var (entry, (backingMember, flag)) in SyntheticFlagMembers)
        {
            var label = $"{nameof(SyntheticFlagMembers)}: {entry.TypeName}.{entry.MemberName}";
            if (Property(typesByName, (entry.TypeName, backingMember)) is not { } backing)
            {
                yield return $"{label} backs onto {backingMember}, which {entry.TypeName} does not reach";
                continue;
            }
            var core = Nullable.GetUnderlyingType(backing.PropertyType) ?? backing.PropertyType;
            if (core.IsEnum)
            {
                if (!Enum.GetNames(core).Contains(flag, StringComparer.Ordinal))
                    yield return $"{label} names flag {flag}, which {core.Name} does not define";
            }
            else if (!ReflectedTypes.IntegerTypes.Contains(core) || !TryParseBit(flag, out _))
            {
                yield return $"{label} backs onto {backingMember}, which is neither an enum nor an integer bit {flag} could name";
            }
        }
    }

    // A label row on a member that is no enum, or naming a member that enum lacks, is a label
    // nothing ever shows.
    private IEnumerable<string> UnresolvedEnumLabels(ILookup<string, Type> typesByName)
    {
        foreach (var (entry, labels) in EnumMemberLabels)
        {
            if (Property(typesByName, entry) is not { } prop) continue;

            var label = $"{nameof(EnumMemberLabels)}: {entry.TypeName}.{entry.MemberName}";
            var core = Nullable.GetUnderlyingType(prop.PropertyType) ?? prop.PropertyType;
            if (!core.IsEnum)
            {
                yield return $"{label} labels members of {core.Name}, which is not an enum";
                continue;
            }
            var names = Enum.GetNames(core).ToHashSet(StringComparer.Ordinal);
            foreach (var member in labels.Keys.Where(m => !names.Contains(m)).Order(StringComparer.Ordinal))
                yield return $"{label} labels member {member}, which {core.Name} does not define";
        }
    }

    // An excluded union that is no union base excludes nothing: the expansion it forbids would never
    // have happened.
    private IEnumerable<string> UnresolvedExcludedUnions(ILookup<string, Type> typesByName)
    {
        foreach (var name in ExcludedUnions.Order(StringComparer.Ordinal))
        {
            if (typesByName[name].FirstOrDefault(t => t.IsClass) is not { } setterType) continue;
            if (!LoquiUnions.IsUnionBase(setterType))
                yield return $"{nameof(ExcludedUnions)}: {name} is no union base, so it expands to nothing to exclude";
        }
    }

    // The row says the game leaves a link Mutagen types non-nullable unset. On a link Mutagen
    // already types nullable, or on something that is no link, it says nothing.
    private IEnumerable<string> UnresolvedPermittedNullLinks(ILookup<string, Type> typesByName)
    {
        foreach (var entry in PermittedNullFormLinks.Order())
        {
            if (Property(typesByName, entry) is not { } prop) continue;
            var label = $"{nameof(PermittedNullFormLinks)}: {entry.TypeName}.{entry.MemberName}";
            if (!ReflectedTypes.IsFormLink(prop.PropertyType))
                yield return $"{label} is no form link ({prop.PropertyType.Name})";
            else if (ReflectedTypes.IsNullableFormLink(prop.PropertyType))
                yield return $"{label} is already a nullable form link, so the row permits nothing";
        }
    }

    // An alpha leaf is a leaf of a Color; on anything else the row names a leaf nothing builds.
    private IEnumerable<string> UnresolvedAlphaFields(ILookup<string, Type> typesByName)
    {
        foreach (var entry in AlphaBearingColorFields.Order())
        {
            if (Property(typesByName, entry) is not { } prop) continue;
            var core = Nullable.GetUnderlyingType(prop.PropertyType) ?? prop.PropertyType;
            if (core != typeof(System.Drawing.Color))
                yield return $"{nameof(AlphaBearingColorFields)}: {entry.TypeName}.{entry.MemberName} is no Color ({core.Name})";
        }
    }

    private static PropertyInfo? Property(ILookup<string, Type> typesByName, (string TypeName, string MemberName) entry) =>
        typesByName[entry.TypeName]
            .SelectMany(ReflectedTypes.GetAllInterfaceProperties)
            .FirstOrDefault(p => p.Name == entry.MemberName);

    private static IEnumerable<string> UnresolvedMembers(
        ILookup<string, Type> typesByName, string concern, IEnumerable<(string TypeName, string MemberName)> entries) =>
        entries
            .Where(e => !typesByName[e.TypeName]
                .Any(t => t.GetProperties(BindingFlags.Public | BindingFlags.Instance).Any(p => p.Name == e.MemberName)))
            .Select(e => $"{concern}: {e.TypeName}.{e.MemberName}");

    // Every shape a member holds, a list by its element shape too, each generic by its definition.
    private static IEnumerable<Type> MemberShapes(IEnumerable<Type> types) =>
        types
            .SelectMany(t => t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            .SelectMany(p =>
            {
                var core = Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType;
                return ReflectedTypes.IsListType(core, out var element) ? [core, element] : new[] { core };
            })
            .Select(t => t.IsGenericType ? t.GetGenericTypeDefinition() : t)
            .Distinct();

    /// <summary>Resolves every row against the assembly's types, its GRUP signatures and the shapes
    /// its members hold, and throws naming each row that does not resolve or is not the kind of
    /// thing its table says it is.</summary>
    public void Validate(Assembly gameAssembly, IEnumerable<string> grupSignatures)
    {
        var allTypes = gameAssembly.GetTypes()
            .SelectMany(t => t.GetInterfaces().Append(t))
            .Distinct()
            .ToList();
        var typesByName = allTypes.ToLookup(t => t.Name, StringComparer.Ordinal);
        var shapes = MemberShapes(allTypes).ToList();
        var shapeNames = shapes.Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
        var shapeFullNames = shapes.Select(t => t.FullName ?? t.Name).ToHashSet(StringComparer.Ordinal);
        var signatures = grupSignatures.ToHashSet(StringComparer.OrdinalIgnoreCase);

        IEnumerable<string> UnresolvedTypes(string concern, IEnumerable<string> entries) =>
            entries.Where(t => !typesByName[t].Any()).Select(t => $"{concern}: {t}");

        string[] missing =
        [
            .. ExcludedSignatures.Keys.Where(s => !signatures.Contains(s)).Order(StringComparer.Ordinal)
                .Select(s => $"{nameof(ExcludedSignatures)}: {s} is no GRUP signature this game declares"),
            .. UnresolvedMembers(typesByName, nameof(ExcludedColumns), ExcludedColumns),
            .. UnresolvedMembers(typesByName, nameof(ExcludedMembers), ExcludedMembers),
            .. UnresolvedTypes(nameof(ExcludedUnions), ExcludedUnions),
            .. UnresolvedExcludedUnions(typesByName),
            .. UnresolvedTypes(nameof(CycleTruncations), CycleTruncations),
            .. UnresolvedTypes(nameof(EmptySubSchemaTypes), EmptySubSchemaTypes),
            .. VectorStructTypes.Where(t => !shapeFullNames.Contains(t)).Order(StringComparer.Ordinal)
                .Select(t => $"{nameof(VectorStructTypes)}: {t} is the shape of no member of this game"),
            .. RefusedShapes.Keys.Where(t => !shapeNames.Contains(t)).Order(StringComparer.Ordinal)
                .Select(t => $"{nameof(RefusedShapes)}: {t} is the shape of no member of this game"),
            .. UnresolvedMembers(typesByName, nameof(EnumMemberLabels), EnumMemberLabels.Keys),
            .. UnresolvedEnumLabels(typesByName),
            .. UnresolvedMembers(typesByName, nameof(KnownDefects), KnownDefects.Select(d => (d.TypeName, d.MemberName))),
            .. UnresolvedMembers(typesByName, nameof(AlphaBearingColorFields), AlphaBearingColorFields),
            .. UnresolvedAlphaFields(typesByName),
            .. UnresolvedMembers(typesByName, nameof(PermittedNullFormLinks), PermittedNullFormLinks),
            .. UnresolvedPermittedNullLinks(typesByName),
            .. UnresolvedMembers(typesByName, nameof(SiblingsInUse), SiblingsInUse.Keys),
            .. UnresolvedSiblingRelations(typesByName),
            .. UnresolvedMembers(typesByName, nameof(KeyedArrays), KeyedArrays.Keys),
            .. UnresolvedKeyMembers(typesByName),
            .. UnresolvedTypes(nameof(SyntheticFlagMembers), SyntheticFlagMembers.Keys.Select(k => k.TypeName)),
            .. UnresolvedSyntheticFlags(typesByName),
        ];

        if (missing.Length > 0)
        {
            throw new InvalidOperationException(
                $"Schema annotations for {gameAssembly.GetName().Name} name types or members reflection did not find " +
                $"— fix or delete each entry: {string.Join("; ", missing)}");
        }
    }

    /// <summary>Throws naming each row that claims something about the walk the walk never did.
    /// Neither fact exists before the whole schema is built.</summary>
    public void ValidateObserved(string gameAssemblyName, WalkObservations observed)
    {
        string[] idle =
        [
            .. CycleTruncations.Where(t => !observed.AppliedTruncations.Contains(t)).Order(StringComparer.Ordinal)
                .Select(t => $"{nameof(CycleTruncations)}: {t} never stops the walk or lets a loop through"),
            .. EmptySubSchemaTypes.Where(t => !observed.EmptySubSchemas.Contains(t)).Order(StringComparer.Ordinal)
                .Select(t => $"{nameof(EmptySubSchemaTypes)}: {t} never comes out empty in the walk"),
        ];

        if (idle.Length > 0)
        {
            throw new InvalidOperationException(
                $"Schema annotations for {gameAssemblyName} claim a walk that did not happen " +
                $"— fix or delete each entry: {string.Join("; ", idle)}");
        }
    }
}

/// <summary>What the walk did with the rows that claim something about the walk itself. The walk
/// records; <see cref="SchemaAnnotations.ValidateObserved"/> reads, once the schema is built.</summary>
internal sealed class WalkObservations
{
    private readonly HashSet<string> _appliedTruncations = new(StringComparer.Ordinal);
    private readonly HashSet<string> _emptySubSchemas = new(StringComparer.Ordinal);

    internal IReadOnlySet<string> AppliedTruncations => _appliedTruncations;
    internal IReadOnlySet<string> EmptySubSchemas => _emptySubSchemas;

    /// <summary>The walk stopped at this truncation, or let a loop through because of it.</summary>
    internal void AppliedTruncation(string getterInterfaceName) => _appliedTruncations.Add(getterInterfaceName);
    internal void CameOutEmpty(string getterInterfaceName) => _emptySubSchemas.Add(getterInterfaceName);
}
