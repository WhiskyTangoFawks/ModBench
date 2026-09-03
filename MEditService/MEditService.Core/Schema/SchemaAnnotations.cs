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
/// <param name="ExcludedAbstractUnions">Abstract setter classes the union-leaf expansion must not
/// model, because their concept is presented by a dedicated section rather than the reflected
/// schema.</param>
/// <param name="EmptySubSchemaTypes">Getter interfaces whose sub-schema is known to come out empty,
/// each with a reasoned entry in <c>SchemaReflectorLeafCoverageCompletenessTests.KnownGaps</c>; the
/// walk reports them as excluded rather than unclassified.</param>
/// <param name="AlphaBearingColorFields">The Color fields xEdit renders with an Alpha leaf
/// (<c>wbByteRGBA</c>); every other Color field takes the 3-leaf <c>wbByteColors</c> shape. A
/// property of the field, not the type — Mutagen selects <c>ColorBinaryType</c> inside generated
/// call sites, unreachable from a property walk — and every row is one Mutagen also writes the
/// alpha byte for, so an alpha edit is never silently discarded at compile.</param>
internal sealed record SchemaAnnotations(
    HashSet<(string TypeName, string MemberName)> ExcludedColumns,
    HashSet<(string TypeName, string MemberName)> ExcludedMembers,
    HashSet<string> ExcludedAbstractUnions,
    HashSet<string> EmptySubSchemaTypes,
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

    // Condition/ConditionData (CTDA) and AVirtualMachineAdapter (VMAD) are abstract exactly like
    // ANpcLevel/AQuestAlias, but their sections own them (Queries/RecordDocumentCodecs).
    private static readonly string[] ConditionAndVmadUnions = ["Condition", "ConditionData", "AVirtualMachineAdapter"];

    private static readonly string[] EmptySubSchemaTypesInEveryGame =
    [
        "IPlacedGetter",                     // abstract placed-record base, no members of its own
        "IScriptFragmentGetter",             // VMAD-adjacent, outside the reflected pipeline by design
        "IScriptEntryGetter",                // ditto
        "IFindMatchingRefFromEventGetter",  // package-data leaf whose own members are all excluded shapes
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
            ExcludedAbstractUnions: [.. ConditionAndVmadUnions],
            EmptySubSchemaTypes:
            [
                .. EmptySubSchemaTypesInEveryGame,
                "IScenePhaseUnusedDataGetter",  // byte-blob-only members
                "IASceneActionTypeGetter",      // deliberately not abstract upstream; see KnownGaps
            ],
            AlphaBearingColorFields: [.. RgbaColorFields]),

        [GameCategory.Skyrim] = new(
            ExcludedColumns: [.. GrupTimestampColumns],
            ExcludedMembers: [.. PlumbingMembers, ("IGlobalGetter", "TypeChar")],
            ExcludedAbstractUnions: [.. ConditionAndVmadUnions],
            EmptySubSchemaTypes: [.. EmptySubSchemaTypesInEveryGame, "IScenePhaseUnusedDataGetter"],
            AlphaBearingColorFields: [.. RgbaColorFields]),

        [GameCategory.Starfield] = new(
            ExcludedColumns: [.. GrupTimestampColumns, ("IQuestGetter", "Timestamp")],
            ExcludedMembers:
            [
                .. PlumbingMembers,
                ("IObjectModStringPropertyGetter`1", "Unused"),
                ("IObjectModEnumPropertyGetter`1", "Unused"),
            ],
            ExcludedAbstractUnions: [.. ConditionAndVmadUnions],
            EmptySubSchemaTypes: [.. EmptySubSchemaTypesInEveryGame],
            AlphaBearingColorFields: [.. RgbaColorFields]),
    };

    /// <summary>A game with no table is a game nobody has written the facts for — loud, not empty.</summary>
    public static SchemaAnnotations For(GameCategory category) =>
        Tables.TryGetValue(category, out var annotations)
            ? annotations
            : throw new InvalidOperationException($"No schema annotation table for {category}");

    public bool IsExcludedColumn(PropertyInfo prop) => ExcludedColumns.Contains(Key(prop));
    public bool IsExcludedMember(PropertyInfo prop) => ExcludedMembers.Contains(Key(prop));
    public bool IsExcludedAbstractUnion(Type setterType) => ExcludedAbstractUnions.Contains(setterType.Name);
    public bool IsEmptySubSchemaType(Type getterInterface) => EmptySubSchemaTypes.Contains(getterInterface.Name);
    public bool HasAlphaLeaf(PropertyInfo prop) => AlphaBearingColorFields.Contains(Key(prop));

    private static (string, string) Key(PropertyInfo prop) => (prop.DeclaringType!.Name, prop.Name);

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
            .. UnresolvedTypes(nameof(ExcludedAbstractUnions), ExcludedAbstractUnions),
            .. UnresolvedTypes(nameof(EmptySubSchemaTypes), EmptySubSchemaTypes),
            .. UnresolvedMembers(nameof(AlphaBearingColorFields), AlphaBearingColorFields),
        ];

        if (missing.Length > 0)
        {
            throw new InvalidOperationException(
                $"Schema annotations for {gameAssembly.GetName().Name} name types or members reflection did not find " +
                $"— fix or delete each entry: {string.Join("; ", missing)}");
        }
    }
}
