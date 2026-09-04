using System.Reflection;
using Mutagen.Bethesda;

namespace MEditService.Core.Schema;

/// <summary>
/// Hand-written per-game facts the reflector overlays on what it reflects from a game's Mutagen
/// assembly — one table per concern, one instance per game, keyed by Mutagen type name and member
/// name, never by a game conditional in the reflector. <see cref="Validate"/> runs before the
/// game's schema is built: an entry naming a type or member reflection does not find fails schema
/// generation and names the entry, so a Mutagen rename can never leave a row silently doing nothing.
/// </summary>
/// <param name="ExcludedColumns">Top-level record properties that are not record data — the GRUP
/// timestamps Mutagen keeps on the record whose group carries them. The serializer still writes
/// them (ADR-0042 decision 3): a reflected column and a source-document field are different
/// promises. Column-scoped: the same property embedded one level down (Worldspace.TopCell's own
/// timestamps) is still walked.</param>
/// <param name="ExcludedMembers">Properties skipped at every depth: Mutagen/Loqui plumbing that is
/// not editor surface, and reserved padding Mutagen names but xEdit never renders. Skipped rather
/// than excluded-with-a-reason, because an exclusion says "real data we chose not to present".
/// Keyed on the declaring type because some of these names are real data elsewhere (<c>Type</c> is
/// a genuine enum on Keyword and others).</param>
/// <param name="ExcludedUnions">Loqui base classes the union-leaf expansion must not model —
/// their concept is presented by a dedicated section rather than the reflected schema, or their
/// leaves cannot be read safely. A struct column whose class is or derives from one is not a
/// column either.</param>
/// <param name="CycleTruncations">Getter interfaces the walk may re-enter on its own path and
/// stop at silently, because the game's data format cannot nest them (a Fallout 4 Papyrus struct
/// member is never itself a struct or a struct array), so the shape is already complete. Any other
/// re-entry is a true type cycle and fails schema generation naming the chain.</param>
/// <param name="EmptySubSchemaTypes">Getter interfaces whose sub-schema is known to come out empty,
/// each with a reasoned entry in <c>SchemaReflectorLeafCoverageCompletenessTests.KnownGaps</c>; the
/// walk reports them as excluded rather than unclassified.</param>
/// <param name="SiblingsInUse">Members whose own value decides which of their sibling members carry
/// data — see <see cref="Queries.FieldMetadata.SiblingsInUse"/> for what the map means. Keyed by the
/// governing member; the inner map is keyed by that member's own enum values — every one of them,
/// since an unnamed value would silently idle every member the row governs — and every name it
/// lists must be a member of the same declaring type. Validated in all four directions, so a
/// Mutagen rename or addition on either side of the relationship fails schema generation.</param>
/// <param name="KeyedArrays">List members whose elements are identified by a key read off the
/// element itself rather than by position — xEdit's <c>wbArrayS</c>. Keyed by the declaring type and
/// the list member; the value is the element member(s) the key is made of, in key order, as
/// wire (snake_case) names, dotted to reach one nested struct member down. A keyed array is aligned
/// across plugins by key in the compare grid and written back in key order, and two elements sharing
/// a key are refused. Validated against the element type, so a Mutagen rename on either side fails
/// schema generation.</param>
/// <param name="PermittedNullFormLinks">FormLink members Mutagen types as non-nullable that the
/// game's own format leaves unset as a matter of course, so an unset one is a value rather than a
/// dangling reference (<see cref="Queries.CheckErrorBuilder"/>) and a resend of the record's own
/// read value is not refused. The CLR type cannot answer this: Mutagen only marks a link nullable
/// when its generated model happens to use <c>IFormLinkNullable</c>.</param>
/// <param name="AlphaBearingColorFields">The Color fields xEdit renders with an Alpha leaf
/// (<c>wbByteRGBA</c>); every other Color field takes the 3-leaf <c>wbByteColors</c> shape. A
/// property of the field, not the type — Mutagen selects <c>ColorBinaryType</c> inside generated
/// call sites, unreachable from a property walk — and every row is one Mutagen also writes the
/// alpha byte for, so an alpha edit is never silently discarded at compile.</param>
internal sealed record SchemaAnnotations(
    HashSet<(string TypeName, string MemberName)> ExcludedColumns,
    HashSet<(string TypeName, string MemberName)> ExcludedMembers,
    HashSet<string> ExcludedUnions,
    HashSet<string> CycleTruncations,
    HashSet<string> EmptySubSchemaTypes,
    Dictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>> SiblingsInUse,
    Dictionary<(string TypeName, string MemberName), IReadOnlyList<string>> KeyedArrays,
    HashSet<(string TypeName, string MemberName)> PermittedNullFormLinks,
    HashSet<(string TypeName, string MemberName)> AlphaBearingColorFields)
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
        // A whole script, and a fragment's own script binding, hung off a fragment struct. Both are
        // reflected in full wherever the walk still has breadth for them (a PERK/PACK/SCEN adapter's
        // own script_fragments.script); this names the deeper positions — an adapter reached through
        // a list element, so already several hops in — where the sub-schema comes out empty and the
        // struct would otherwise be an unclassified anomaly.
        "IScriptFragmentGetter",
        "IScriptEntryGetter",
    ];

    // wbByteRGBA in Fallout 4 (wbDefinitionsFO4.pas:7028 KYWD, :7040 LCRT, :7051 AACT, :8256 LCTN),
    // Skyrim (wbDefinitionsTES5.pas:5321, :5326, :5331, :6511) and Starfield (wbDefinitionsSF1.pas:13697,
    // :13759, :9519, :13963); ColorBinaryType.Alpha on the Mutagen side (Keyword_Generated.cs:1875, LocationReferenceType_Generated.cs:1510,
    // ActionRecord_Generated.cs:1766, Location_Generated.cs:5435).
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
                // unimplemented throw upstream; the full scheme is on KnownGaps' ISceneActionGetter.Type.
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
            AlphaBearingColorFields: [.. RgbaColorFields]),

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
            AlphaBearingColorFields: [.. RgbaColorFields]),

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
            AlphaBearingColorFields: [.. RgbaColorFields]),
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

    private static (string, string) Key(PropertyInfo prop) => (prop.DeclaringType!.Name, prop.Name);

    /// <summary>Everything about a <see cref="SiblingsInUse"/> row that reflection has to agree
    /// with: it governs from an enum, the inner map's keys are exactly that enum's own members, and
    /// every sibling it names is a member of the same declaring type under the schema's own
    /// snake_case naming. A row that named a value or a sibling the assembly does not have would
    /// silently govern nothing; one that omitted a value would silently idle everything under
    /// it.</summary>
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
                .Select(p => ReflectedTypes.ToSnakeCase(p.Name))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

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

    /// <summary>Everything about a <see cref="KeyedArrays"/> row reflection has to agree with: the
    /// member is a list, and each key path resolves member by member off the element type under the
    /// schema's own snake_case naming. A row naming a key the element does not have would key every
    /// element alike, silently collapsing the array to one row in the compare grid and refusing
    /// every second element as a duplicate on write.</summary>
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
                .FirstOrDefault(p => ReflectedTypes.ToSnakeCase(p.Name).Equals(segments[i], StringComparison.OrdinalIgnoreCase));
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

    /// <summary>
    /// Resolves every entry against the game assembly's own types and every interface they
    /// implement (which is where Loqui's and Mutagen.Bethesda.Core's plumbing interfaces come from).
    /// Throws naming each entry that did not resolve.
    /// </summary>
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
        ];

        if (missing.Length > 0)
        {
            throw new InvalidOperationException(
                $"Schema annotations for {gameAssembly.GetName().Name} name types or members reflection did not find " +
                $"— fix or delete each entry: {string.Join("; ", missing)}");
        }
    }
}
