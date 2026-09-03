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
/// not editor surface, and reserved padding Mutagen names but xEdit never renders. Keyed on the
/// declaring type because some of these names are real data elsewhere (<c>Type</c> is a genuine
/// enum on Keyword and others).</param>
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
    IReadOnlyList<(string TypeName, string MemberName)> ExcludedColumns,
    IReadOnlyList<(string TypeName, string MemberName)> ExcludedMembers,
    IReadOnlyList<string> ExcludedAbstractUnions,
    IReadOnlyList<string> EmptySubSchemaTypes,
    IReadOnlyList<(string TypeName, string MemberName)> AlphaBearingColorFields)
{
    // Mutagen.Bethesda.Core / Loqui plumbing every game's getters implement.
    private static readonly (string, string)[] MutagenPlumbingMembers =
    [
        ("ILoquiObject", "Registration"),          // Loqui's own registration handle
        ("IBinaryItem", "BinaryWriteTranslator"),  // Mutagen's binary write-strategy object
        ("ILinkIdentifier", "Type"),               // a System.Type, not a record field
        ("IFormKeyGetter", "FormKey"),             // record identity, the header's own column
    ];

    // Condition/ConditionData (CTDA) and AVirtualMachineAdapter (VMAD) are abstract exactly like
    // ANpcLevel/AQuestAlias, but their sections own them (Queries/RecordDocumentCodecs).
    private static readonly string[] ConditionAndVmadUnions = ["Condition", "ConditionData", "AVirtualMachineAdapter"];

    // The four fields are wbByteRGBA in Fallout 4 (wbDefinitionsFO4.pas:7028 KYWD, :7040 LCRT,
    // :7051 AACT, :8256 LCTN) and in Skyrim (wbDefinitionsTES5.pas:5321, :5326, :5331, :6511), and
    // ColorBinaryType.Alpha on the Mutagen side (Keyword_Generated.cs:1875,
    // LocationReferenceType_Generated.cs:1510, ActionRecord_Generated.cs:1766, Location_Generated.cs:5435).
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
            ExcludedColumns:
            [
                ("ICellGetter", "Timestamp"), ("ICellGetter", "PersistentTimestamp"), ("ICellGetter", "TemporaryTimestamp"),
                ("IDialogTopicGetter", "Timestamp"),
                ("IQuestGetter", "Timestamp"),
            ],
            ExcludedMembers:
            [
                .. MutagenPlumbingMembers,
                ("IGlobalGetter", "TypeChar"),                       // GLOB's derived subclass discriminant char
                ("IAMagicEffectArchetypeGetter", "AssociationKey"),  // IFormLinkIdentifier alias of Association
                // Reserved padding: wbUnused(3)/wbUnused(2) in wbDefinitionsFO4.pas's wbObjectModProperties
                ("IObjectModStringPropertyGetter`1", "Unused"),
                ("IObjectModEnumPropertyGetter`1", "Unused"),
            ],
            ExcludedAbstractUnions: ConditionAndVmadUnions,
            EmptySubSchemaTypes:
            [
                "IScenePhaseUnusedDataGetter",      // byte-blob-only members
                "IPlacedGetter",                     // abstract placed-record base, no members of its own
                "IScriptFragmentGetter",             // VMAD-adjacent, outside the reflected pipeline by design
                "IScriptEntryGetter",                // ditto
                "IFindMatchingRefFromEventGetter",  // package-data leaf whose own members are all excluded shapes
                "IASceneActionTypeGetter",          // deliberately not abstract upstream; see KnownGaps
            ],
            AlphaBearingColorFields: RgbaColorFields),

        [GameCategory.Skyrim] = new(
            ExcludedColumns:
            [
                ("ICellGetter", "Timestamp"), ("ICellGetter", "PersistentTimestamp"), ("ICellGetter", "TemporaryTimestamp"),
                ("IDialogTopicGetter", "Timestamp"),
            ],
            ExcludedMembers:
            [
                .. MutagenPlumbingMembers,
                ("IGlobalGetter", "TypeChar"),
                ("IAMagicEffectArchetypeGetter", "AssociationKey"),
            ],
            ExcludedAbstractUnions: ConditionAndVmadUnions,
            EmptySubSchemaTypes:
            [
                "IScenePhaseUnusedDataGetter",
                "IPlacedGetter",
                "IScriptFragmentGetter",
                "IScriptEntryGetter",
                "IFindMatchingRefFromEventGetter",
            ],
            AlphaBearingColorFields: RgbaColorFields),

        [GameCategory.Starfield] = new(
            ExcludedColumns:
            [
                ("ICellGetter", "Timestamp"), ("ICellGetter", "PersistentTimestamp"), ("ICellGetter", "TemporaryTimestamp"),
                ("IDialogTopicGetter", "Timestamp"),
                ("IQuestGetter", "Timestamp"),
            ],
            ExcludedMembers:
            [
                .. MutagenPlumbingMembers,
                ("IAMagicEffectArchetypeGetter", "AssociationKey"),
                ("IObjectModStringPropertyGetter`1", "Unused"),
                ("IObjectModEnumPropertyGetter`1", "Unused"),
            ],
            ExcludedAbstractUnions: ConditionAndVmadUnions,
            EmptySubSchemaTypes:
            [
                "IPlacedGetter",
                "IScriptFragmentGetter",
                "IScriptEntryGetter",
                "IFindMatchingRefFromEventGetter",
            ],
            AlphaBearingColorFields: RgbaColorFields),
    };

    /// <summary>A game with no table is a game nobody has written the facts for — loud, not empty.</summary>
    public static SchemaAnnotations For(GameCategory category) =>
        Tables.TryGetValue(category, out var annotations)
            ? annotations
            : throw new InvalidOperationException($"No schema annotation table for {category}");

    private readonly HashSet<(string, string)> _excludedColumns = [.. ExcludedColumns];
    private readonly HashSet<(string, string)> _excludedMembers = [.. ExcludedMembers];
    private readonly HashSet<string> _excludedAbstractUnions = new(ExcludedAbstractUnions, StringComparer.Ordinal);
    private readonly HashSet<string> _emptySubSchemaTypes = new(EmptySubSchemaTypes, StringComparer.Ordinal);
    private readonly HashSet<(string, string)> _alphaBearingColorFields = [.. AlphaBearingColorFields];

    public bool IsExcludedColumn(PropertyInfo prop) => _excludedColumns.Contains(Key(prop));
    public bool IsExcludedMember(PropertyInfo prop) => _excludedMembers.Contains(Key(prop));
    public bool IsExcludedAbstractUnion(Type setterType) => _excludedAbstractUnions.Contains(setterType.Name);
    public bool IsEmptySubSchemaType(Type getterInterface) => _emptySubSchemaTypes.Contains(getterInterface.Name);
    public bool HasAlphaLeaf(PropertyInfo prop) => _alphaBearingColorFields.Contains(Key(prop));

    private static (string, string) Key(PropertyInfo prop) => (prop.DeclaringType?.Name ?? "", prop.Name);

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
        bool MemberFound(string typeName, string memberName) => typesByName[typeName]
            .Any(t => t.GetProperties(BindingFlags.Public | BindingFlags.Instance).Any(p => p.Name == memberName));

        var missing = new List<string>();
        void Check(string concern, IEnumerable<(string TypeName, string MemberName)> entries)
        {
            foreach (var (type, member) in entries.Where(e => !MemberFound(e.TypeName, e.MemberName)))
                missing.Add($"{concern}: {type}.{member}");
        }
        void CheckTypes(string concern, IEnumerable<string> entries)
        {
            foreach (var type in entries.Where(t => !TypeFound(t)))
                missing.Add($"{concern}: {type}");
        }

        Check(nameof(ExcludedColumns), ExcludedColumns);
        Check(nameof(ExcludedMembers), ExcludedMembers);
        CheckTypes(nameof(ExcludedAbstractUnions), ExcludedAbstractUnions);
        CheckTypes(nameof(EmptySubSchemaTypes), EmptySubSchemaTypes);
        Check(nameof(AlphaBearingColorFields), AlphaBearingColorFields);

        if (missing.Count > 0)
        {
            throw new InvalidOperationException(
                $"Schema annotations for {gameAssembly.GetName().Name} name types or members reflection did not find " +
                $"— fix or delete each entry: {string.Join("; ", missing)}");
        }
    }
}
