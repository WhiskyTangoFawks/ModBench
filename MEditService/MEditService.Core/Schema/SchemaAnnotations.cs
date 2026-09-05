using System.Reflection;
using Mutagen.Bethesda;

namespace MEditService.Core.Schema;

/// <summary>Hand-written per-game facts overlaid on what reflection finds, keyed by Mutagen type and
/// member name. <see cref="Validate"/> fails schema generation naming any entry reflection cannot
/// find, so a rename never idles a row.</summary>
internal sealed record SchemaAnnotations(
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
        // A script and a fragment's script binding, several hops in through a list element, where the
        // sub-schema comes out empty; shallower positions reflect both in full.
        "IScriptFragmentGetter",
        "IScriptEntryGetter",
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

    private static readonly Dictionary<GameCategory, SchemaAnnotations> Tables = new()
    {
        [GameCategory.Fallout4] = new(
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
                // unimplemented throw upstream.
                "ASceneActionType",
            ],
            CycleTruncations: ["IScriptStructPropertyGetter", "IScriptStructListPropertyGetter"],
            EmptySubSchemaTypes:
            [
                .. EmptySubSchemaTypesInEveryGame,
                "IASceneActionTypeGetter",      // deliberately not abstract upstream; see KnownGaps
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
            ExcludedColumns: [.. GrupTimestampColumns],
            ExcludedMembers: [.. PlumbingMembers, ("IGlobalGetter", "TypeChar")],
            ExcludedUnions: [],
            CycleTruncations: [],
            EmptySubSchemaTypes: [.. EmptySubSchemaTypesInEveryGame],
            // This repo builds no Skyrim schema, so a condition or keyed-array row written here could
            // not be validated against the assembly it describes. Empty until one can be built.
            SiblingsInUse: [],
            KeyedArrays: [],
            PermittedNullFormLinks: [],
            AlphaBearingColorFields: [.. RgbaColorFields],
            SyntheticFlagMembers: []),

        [GameCategory.Starfield] = new(
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
            // Empty for the same reason as Skyrim's above.
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
    public bool HasAlphaLeaf(PropertyInfo prop) => AlphaBearingColorFields.Contains(Key(prop));
    public bool IsPermittedNullFormLink(PropertyInfo prop) => PermittedNullFormLinks.Contains(Key(prop));
    public IReadOnlyDictionary<string, IReadOnlyList<string>>? SiblingsInUseFor(PropertyInfo prop) =>
        SiblingsInUse.GetValueOrDefault(Key(prop));
    public IReadOnlyList<string>? KeyMembersFor(PropertyInfo prop) => KeyedArrays.GetValueOrDefault(Key(prop));

    public IEnumerable<(string Name, string BackingMember, string Flag)> SyntheticFlagMembersFor(Type getterType) =>
        SyntheticFlagMembers
            .Where(e => e.Key.TypeName == getterType.Name)
            .Select(e => (e.Key.MemberName, e.Value.BackingMember, e.Value.Flag));

    private static (string, string) Key(PropertyInfo prop) => (prop.DeclaringType!.Name, prop.Name);

    // A row naming a value or sibling the assembly lacks would silently govern nothing; one omitting
    // a value would silently idle everything under it.
    private IEnumerable<string> UnresolvedSiblingRelations(ILookup<string, Type> typesByName)
    {
        foreach (var (entry, byValue) in SiblingsInUse)
        {
            var declaring = typesByName[entry.TypeName]
                .FirstOrDefault(t => t.GetProperty(entry.MemberName) != null);
            if (declaring == null) continue;   // already reported by UnresolvedMembers above

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
            if (declaring == null) continue;   // already reported by UnresolvedMembers above

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
            var backing = typesByName[entry.TypeName]
                .SelectMany(ReflectedTypes.GetAllInterfaceProperties)
                .FirstOrDefault(p => p.Name == backingMember);
            if (backing == null)
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
            else if (!ReflectedTypes.IntegerTypes.Contains(core)
                || !flag.StartsWith("0x", StringComparison.Ordinal)
                || !long.TryParse(flag.AsSpan(2), System.Globalization.NumberStyles.HexNumber, null, out _))
            {
                yield return $"{label} backs onto {backingMember}, which is neither an enum nor an integer bit {flag} could name";
            }
        }
    }

    /// <summary>Resolves every entry against the assembly's types and every interface they implement,
    /// which is where Loqui's plumbing interfaces come from. Throws naming each unresolved entry.</summary>
    public void Validate(Assembly gameAssembly)
    {
        var typesByName = gameAssembly.GetTypes()
            .SelectMany(t => t.GetInterfaces().Append(t))
            .Distinct()
            .ToLookup(t => t.Name, StringComparer.Ordinal);

        bool TypeFound(string typeName) => typesByName[typeName].Any();
        bool MemberFound((string TypeName, string MemberName) entry) => typesByName[entry.TypeName]
            .Any(t => t.GetProperties(BindingFlags.Public | BindingFlags.Instance).Any(p => p.Name == entry.MemberName));

        IEnumerable<string> UnresolvedMembers(string concern, IEnumerable<(string TypeName, string MemberName)> entries) =>
            entries.Where(e => !MemberFound(e)).Select(e => $"{concern}: {e.TypeName}.{e.MemberName}");
        IEnumerable<string> UnresolvedTypes(string concern, IEnumerable<string> entries) =>
            entries.Where(t => !TypeFound(t)).Select(t => $"{concern}: {t}");

        string[] missing =
        [
            .. UnresolvedMembers(nameof(ExcludedColumns), ExcludedColumns),
            .. UnresolvedMembers(nameof(ExcludedMembers), ExcludedMembers),
            .. UnresolvedTypes(nameof(ExcludedUnions), ExcludedUnions),
            .. UnresolvedTypes(nameof(CycleTruncations), CycleTruncations),
            .. UnresolvedTypes(nameof(EmptySubSchemaTypes), EmptySubSchemaTypes),
            .. UnresolvedMembers(nameof(AlphaBearingColorFields), AlphaBearingColorFields),
            .. UnresolvedMembers(nameof(PermittedNullFormLinks), PermittedNullFormLinks),
            .. UnresolvedMembers(nameof(SiblingsInUse), SiblingsInUse.Keys),
            .. UnresolvedSiblingRelations(typesByName),
            .. UnresolvedMembers(nameof(KeyedArrays), KeyedArrays.Keys),
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
}
