using System.Reflection;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Schema;

/// <summary>What one known Mutagen defect does to the schema and to a gesture: the member it is
/// keyed to, and the reason the user is shown.</summary>
public sealed record KnownDefect(string TypeName, string MemberName, KnownDefectEffect Effect, string Reason);

public enum KnownDefectEffect
{
    /// <summary>The schema names the member and carries the reason; the write path refuses any
    /// path reaching it.</summary>
    MemberReadOnly,
}

/// <summary>One member of the plugin header the editor presents: its xEdit label where it is a
/// record header member, why a write reaching it is refused, and whether it reads as the header's
/// FormKey.</summary>
public sealed record PluginHeaderMember(
    string TypeName, string MemberName, string? HeaderLabel = null, string? ReadOnlyReason = null, bool IsRecordFormKey = false,
    bool IsVersionControlInfo1 = false);

/// <summary>A member that says where a record sits in its container, on every record whose getter has
/// the interface TypeName names, and why a write to it is refused.</summary>
public sealed record ContainmentMember(string TypeName, string MemberName, string Reason);

/// <summary>One member of the record header: its xEdit label, and whether the game ignores it, so the
/// compare shows it and takes it into no conflict (xEdit's cpIgnore).</summary>
public sealed record RecordHeaderMember(
    string TypeName, string MemberName, string Label, bool IgnoredInConflicts = false, bool IsVersionControlInfo1 = false);

/// <summary>Hand-written per-game facts overlaid on reflection, keyed by Mutagen type and member
/// name. <see cref="Validate"/> fails schema generation naming any row the assembly does not bear
/// out.</summary>
public sealed record SchemaAnnotations(
    // Top-level properties that are not record data: GRUP timestamps. The serializer still writes
    // them (ADR-0006); a reflected column and a source-document field are different promises.
    HashSet<(string TypeName, string MemberName)> ExcludedColumns,
    // Skipped at every depth: Loqui plumbing and reserved padding. Keyed on the declaring type
    // because some names are real data elsewhere (Type is a genuine enum on Keyword).
    HashSet<(string TypeName, string MemberName)> ExcludedMembers,
    // Loqui bases the union-leaf expansion must not model: presented by a dedicated section instead,
    // or their leaves cannot be read safely. A struct column deriving from one is not a column either.
    HashSet<string> ExcludedUnions,
    // Loqui bases whose leaves are one function each: the discriminator is the Function row, and
    // each leaf reads as its function's name (editor-fields.md § Conditions, story 3).
    HashSet<string> FunctionUnions,
    // Members a function union's leaves declare only for a slot their function leaves unused, keyed by
    // the base or a class under it, for each leaf beneath: no row (editor-fields.md § Conditions, story 1).
    HashSet<(string TypeName, string MemberName)> UnusedSlotMembers,
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
    // xEdit's own name for an enum member the document spells with Mutagen's (ADR-0005).
    Dictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, string>> EnumMemberLabels,
    // Upstream Mutagen defects, each with an effect the schema and the write path honour. A defect
    // identified only by an exception message is a plugin diagnosis, not a row here.
    IReadOnlyList<KnownDefect> KnownDefects,
    // See FieldMetadata.SiblingsInUse. The inner map must name every enum value, since an unnamed one
    // would silently idle every member the row governs; validated in all four directions.
    IReadOnlyDictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>> SiblingsInUse,
    // xEdit's wbArrayS: elements identified by key members (Mutagen member names, dotted one struct
    // down), not by position. Aligned by key in the compare grid, kept in the order held.
    Dictionary<(string TypeName, string MemberName), IReadOnlyList<string>> KeyedArrays,
    // See FieldMetadata.ExtendedKeyMembers; every row extends a KeyedArrays row.
    Dictionary<(string TypeName, string MemberName), IReadOnlyList<string>> ExtendedKeys,
    // FormLinks Mutagen types non-nullable that the game's format leaves unset as a matter of course,
    // so an unset one is a value, not a dangling reference. The CLR type cannot answer this.
    HashSet<(string TypeName, string MemberName)> PermittedNullFormLinks,
    // The placed reference's rotation: xEdit's wbVec3PosRot, whose rotation reads in degrees where
    // Mutagen holds radians. No type marks it, and a member named Rotation is not always one.
    HashSet<(string TypeName, string MemberName)> PlacedRotations,
    // Plugin header members the document never spells but one flag of a flags member says: the ESL
    // flag. Flag names the backing enum's member.
    Dictionary<(string TypeName, string MemberName), (string BackingMember, string Flag)> SyntheticFlagMembers,
    // The record header's members in xEdit's order, under xEdit's labels (wbRecordHeader in
    // wbDefinitionsCommon.pas), keyed by the declaring interface: a type carries the rows whose
    // interface it has.
    IReadOnlyList<RecordHeaderMember> RecordHeaderMembers,
    // Record Flags bits no flag view of the type names, under the name Mutagen gives the same bit on
    // another type, keyed by the type's getter interface.
    IReadOnlyList<(string TypeName, long Bit, string Name)> RecordFlagNames,
    // Flags enums Mutagen nests in a record class for its Record Flags and spells through no member,
    // keyed by the type's getter interface. A type with several has one per base record type.
    IReadOnlyList<(string TypeName, string EnumName)> RecordFlagEnums,
    // An exterior cell's width in world units. Unchecked: Mutagen divides by it as a literal and
    // exposes no member that holds it.
    float ExteriorCellWidth,
    // The plugin that alone defines a cell a Partial Form copy can override (xEdit's GetCanBePartial),
    // or null where any plugin can. Validated as one of the game's base masters.
    string? PartialFormCellsDefinedIn,
    // The plugin header's presented members, keyed by the game's ModHeader interface: its record
    // header under xEdit's labels, then the rest. No interface over every game's ModHeader names them.
    IReadOnlyList<PluginHeaderMember> PluginHeaderMembers,
    // Members a field edit cannot move a record by, keyed by an interface the record's getter has,
    // not the member's declarer, so a row reaches every record of its kind. Child slots are
    // reflected, not rows.
    IReadOnlyList<ContainmentMember> ContainmentMembers,
    // xEdit's name for a record type the game spells differently from the other games, by table name.
    IReadOnlyDictionary<string, string> DisplayNameOverrides)
{
    // Rows several games share are named once here; a row of one game is written inline in that
    // game's table.

    public static readonly IReadOnlyList<(string, string)> GrupTimestampColumns =
    [
        ("ICellGetter", "Timestamp"), ("ICellGetter", "PersistentTimestamp"), ("ICellGetter", "TemporaryTimestamp"),
        ("IDialogTopicGetter", "Timestamp"),
    ];

    // Not editor surface in any game: Mutagen.Bethesda.Core / Loqui plumbing, and one generated alias.
    public static readonly IReadOnlyList<(string, string)> PlumbingMembers =
    [
        ("ILoquiObject", "Registration"),                    // Loqui's own registration handle
        ("IBinaryItem", "BinaryWriteTranslator"),            // Mutagen's binary write-strategy object
        ("ILinkIdentifier", "Type"),                         // a System.Type, not a record field
        ("IFormKeyGetter", "FormKey"),                       // record identity, the header's own column
        ("IAMagicEffectArchetypeGetter", "AssociationKey"),  // IFormLinkIdentifier alias of Association
    ];

    // Mutagen's names for a condition slot's raw value under a function that reads nothing from it.
    public static readonly IReadOnlyList<(string, string)> UnusedConditionSlotCarriers =
    [
        ("ConditionData", "FirstUnusedIntParameter"),
        ("ConditionData", "FirstUnusedStringParameter"),
        ("ConditionData", "SecondUnusedIntParameter"),
        ("ConditionData", "SecondUnusedStringParameter"),
    ];

    // The header members Mutagen.Bethesda.Core declares on every game's major records, leading
    // xEdit's order; each game's base adds the rest.
    public static readonly IReadOnlyList<RecordHeaderMember> RecordHeaderMembersInEveryGame =
    [
        new("IMajorRecordGetter", "MajorRecordFlagsRaw", "Record Flags"),
        new("IFormKeyGetter", "FormKey", "FormID"),
        new("IMajorRecordGetter", "VersionControl", "Version Control Info 1", IgnoredInConflicts: true, IsVersionControlInfo1: true),
        new("IMajorRecordGetter", "FormVersion", "Form Version", IgnoredInConflicts: true),
    ];

    // Each game's ModHeader declares these (its *ModHeader.xml in Mutagen), the TES4 record's header
    // first, in wbRecordHeader's order (wbDefinitionsCommon.pas).
    public static PluginHeaderMember[] PluginHeaderMembersOf(string modHeaderGetter) =>
    [
        new(modHeaderGetter, "Flags", "Record Flags"),
        new(modHeaderGetter, "FormID", "FormID", PluginHeader.FormIdReadOnly, IsRecordFormKey: true),
        new(modHeaderGetter, "Version", "Version Control Info 1", IsVersionControlInfo1: true),
        new(modHeaderGetter, "FormVersion", "Form Version"),
        new(modHeaderGetter, "Version2", "Version Control Info 2"),
        new(modHeaderGetter, "Author"),
        // ADR-0008.
        new(modHeaderGetter, PluginHeader.MastersFieldName, ReadOnlyReason: "masters are wholly content-derived at compile time"),
    ];

    public static readonly ContainmentMember CellGridInEveryGame = new(
        "ICellGetter", RecordTypes.CellGridMember,
        "it is an exterior cell's own place in the world — it decides the block and sub-block directories that hold " +
        "the cell's source, so moving it restructures the tree rather than rewriting one file. That is a structural " +
        "gesture, not a field edit");

    public static readonly IReadOnlyList<string> EmptySubSchemaTypesInEveryGame =
    [
        "IPlacedGetter",                     // abstract placed-record base, no members of its own
    ];

    // The siblings left out (P2Double, P3Double, P3Int, the wrapper types) are the shape of no
    // member in these games' record graphs, which is what the validation below proves.
    public static readonly IReadOnlyList<string> VectorStructTypesInEveryGame =
    [
        "Noggog.P3Int16", "Noggog.P3Float",
        "Noggog.P2Int", "Noggog.P2Int16", "Noggog.P2Float",
    ];

    // Counts are live, from the audit's enumeration over Fallout 4.
    public static readonly IReadOnlyList<KeyValuePair<string, string>> RefusedShapesInEveryGame =
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

    // wbFileHeader in wbDefinitionsFO4.pas and wbDefinitionsTES5.pas spells the master and light-master bits ESM and ESL.
    // Localized is already xEdit's own spelling, so it carries no label.
    public static readonly IReadOnlyDictionary<string, string> XEditModHeaderFlagNames = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["Master"] = "ESM",
        ["Small"] = "ESL",
    };

    public const string PartialFormName = "PartialForm";

    // PlacedObject.cs's per-base-type enums in every game, as wbREFRRecordFlagsDecider chooses them.
    public static readonly IReadOnlyList<(string, string)> PlacedObjectRecordFlagEnums =
    [
        ("IPlacedObjectGetter", "DefaultMajorFlag"),
        ("IPlacedObjectGetter", "StaticMajorFlag"),
        ("IPlacedObjectGetter", "ContainerMajorFlag"),
        ("IPlacedObjectGetter", "DoorMajorFlag"),
        ("IPlacedObjectGetter", "LightMajorFlag"),
        ("IPlacedObjectGetter", "MoveableStaticMajorFlag"),
        ("IPlacedObjectGetter", "AddonNodeMajorFlag"),
        ("IPlacedObjectGetter", "ItemMajorFlag"),
    ];

    internal bool IsExcludedColumn(PropertyInfo prop) => ExcludedColumns.Contains(Key(prop));
    internal bool IsExcludedMember(PropertyInfo prop) => ExcludedMembers.Contains(Key(prop));
    internal bool IsExcludedUnion(Type setterType)
    {
        for (var t = setterType; t != null; t = t.BaseType)
            if (ExcludedUnions.Contains(t.Name)) return true;
        return false;
    }
    internal bool IsFunctionUnion(Type setterType) => FunctionUnions.Contains(setterType.Name);
    internal bool IsUnusedSlotMember(Type leafGetter, PropertyInfo prop) =>
        ReflectedTypes.GetSetterType(leafGetter) is { } leaf
        && ReflectedTypes.BaseChain(leaf).Any(t => UnusedSlotMembers.Contains((t.Name, prop.Name)));
    internal bool IsCycleTruncation(Type getterInterface) => CycleTruncations.Contains(getterInterface.Name);
    internal bool IsEmptySubSchemaType(Type getterInterface) => EmptySubSchemaTypes.Contains(getterInterface.Name);
    internal bool IsVectorStructType(Type type) => VectorStructTypes.Contains(type.FullName ?? type.Name);
    internal string? RefusedShapeReason(Type shape) => RefusedShapes.GetValueOrDefault(ShapeName(shape));
    internal bool IsPermittedNullFormLink(PropertyInfo prop) => PermittedNullFormLinks.Contains(Key(prop));
    internal bool IsPlacedRotation(PropertyInfo prop) => PlacedRotations.Contains(Key(prop));
    internal IReadOnlyDictionary<string, string>? EnumLabelsFor(PropertyInfo prop) =>
        EnumMemberLabels.GetValueOrDefault(Key(prop));
    internal IReadOnlyDictionary<string, IReadOnlyList<string>>? SiblingsInUseFor(PropertyInfo prop) =>
        SiblingsInUse.GetValueOrDefault(Key(prop));
    internal IReadOnlyList<string>? KeyMembersFor(PropertyInfo prop) => KeyedArrays.GetValueOrDefault(Key(prop));
    internal IReadOnlyList<string>? ExtendedKeyMembersFor(PropertyInfo prop) => ExtendedKeys.GetValueOrDefault(Key(prop));

    /// <summary>The defect keyed to this member, or null: a member with no row is an ordinary one.</summary>
    internal KnownDefect? DefectFor(PropertyInfo prop) =>
        KnownDefects.FirstOrDefault(d => d.TypeName == ReflectedTypes.DeclaringTypeOf(prop).Name && d.MemberName == prop.Name);

    /// <summary>Why a defect keeps this member out of every write, or null.</summary>
    internal string? ReadOnlyReasonFor(PropertyInfo prop) =>
        DefectFor(prop) is { Effect: KnownDefectEffect.MemberReadOnly } defect ? defect.Reason : null;

    /// <summary>Why a write to <paramref name="member"/> of a record of these getters is refused, or null.</summary>
    internal string? ContainmentReasonFor(IEnumerable<Type> recordGetters, string member) =>
        ContainmentMembers.FirstOrDefault(row => row.MemberName == member
            && recordGetters.Any(getter => getter.GetInterfaces().Append(getter).Any(i => i.Name == row.TypeName)))?.Reason;

    internal IEnumerable<(long Bit, string Name)> RecordFlagNamesFor(Type getterType) =>
        RecordFlagNames.Where(r => r.TypeName == getterType.Name).Select(r => (r.Bit, r.Name));

    internal IReadOnlyList<Type> RecordFlagEnumsFor(Type getterType) =>
        ReflectedTypes.GetSetterType(getterType) is { } recordClass
            ? [.. RecordFlagEnums.Where(r => r.TypeName == getterType.Name).Select(r => NestedEnum(recordClass, r.EnumName)).OfType<Type>()]
            : [];

    private static Type? NestedEnum(Type recordClass, string name) =>
        ReflectedTypes.BaseChain(recordClass).Select(c => c.GetNestedType(name)).FirstOrDefault(t => t is { IsEnum: true });

    internal IEnumerable<(string Name, string BackingMember, string Flag)> SyntheticFlagMembersFor(Type getterType) =>
        SyntheticFlagMembers
            .Where(e => e.Key.TypeName == getterType.Name)
            .Select(e => (e.Key.MemberName, e.Value.BackingMember, e.Value.Flag));

    private static (string, string) Key(PropertyInfo prop) => (ReflectedTypes.DeclaringTypeOf(prop).Name, prop.Name);

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

            var property = declaring.GetProperty(entry.MemberName)
                ?? throw new InvalidOperationException(
                    $"Expected '{declaring.Name}' to still declare '{entry.MemberName}'.");
            var enumType = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
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

    private IEnumerable<string> UnresolvedKeyMembers(ILookup<string, Type> typesByName) =>
    [
        .. UnresolvedKeyPaths(typesByName, nameof(KeyedArrays), KeyedArrays, listOrders: false),
        // xEdit's extended sort key orders by a list too, as a leveled entry's conditions.
        .. UnresolvedKeyPaths(typesByName, nameof(ExtendedKeys), ExtendedKeys, listOrders: true),
        .. ExtendedKeys.Keys.Where(entry => !KeyedArrays.ContainsKey(entry))
            .Select(entry => $"{nameof(ExtendedKeys)}: {entry.TypeName}.{entry.MemberName} extends no keyed array"),
    ];

    // A row naming a key the element lacks would key every element alike, so the array would align
    // by position alone.
    private static IEnumerable<string> UnresolvedKeyPaths(
        ILookup<string, Type> typesByName, string table, Dictionary<(string TypeName, string MemberName), IReadOnlyList<string>> rows,
        bool listOrders)
    {
        foreach (var (entry, keyMembers) in rows)
        {
            var declaring = typesByName[entry.TypeName].FirstOrDefault(t => t.GetProperty(entry.MemberName) != null);
            if (declaring == null) continue;

            var property = declaring.GetProperty(entry.MemberName)
                ?? throw new InvalidOperationException(
                    $"Expected '{declaring.Name}' to still declare '{entry.MemberName}'.");
            var label = $"{table}: {entry.TypeName}.{entry.MemberName}";
            if (!ReflectedTypes.IsListType(property.PropertyType, out var elementType))
            {
                yield return $"{label} is not a list";
                continue;
            }

            foreach (var keyPath in keyMembers)
            {
                if (UnresolvedKeyPath(elementType, keyPath, listOrders) is { } why) yield return $"{label} {why}";
            }
        }
    }

    private static string? UnresolvedKeyPath(Type elementType, string keyPath, bool listOrders)
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
                return !listOrders && ReflectedTypes.IsListType(prop.PropertyType, out _)
                    ? $"names key {keyPath}, which is itself a list — a key is one value per element"
                    : null;
            }

            if (!ReflectedTypes.IsLoquiInterface(prop.PropertyType))
                return $"names key {keyPath}, whose {segments[i]} hop is not a struct to descend into";
            owner = prop.PropertyType;
        }
        return null;
    }

    // A row naming an enum a member already spells repeats what the record's flag views name.
    private IEnumerable<string> UnresolvedRecordFlagEnums(ILookup<string, Type> typesByName)
    {
        foreach (var (typeName, enumName) in RecordFlagEnums)
        {
            var label = $"{nameof(RecordFlagEnums)}: {typeName} {enumName}";
            if (typesByName[typeName].Select(ReflectedTypes.GetSetterType).OfType<Type>().FirstOrDefault() is not { } recordClass)
                yield return $"{label} names no type with a record class";
            else if (NestedEnum(recordClass, enumName) is not { } flags)
                yield return $"{label} is no enum {recordClass.Name} nests";
            else if (flags.GetCustomAttribute<FlagsAttribute>() == null)
                yield return $"{label} is no flags enum";
            else if (recordClass.GetProperties().Any(p => (Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType) == flags))
                yield return $"{label} is spelled by a member, so the type's flag views already name it";
        }
    }

    // A row backs onto a flags member the type reaches, and its flag is a name that enum defines.
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
            if (!core.IsEnum)
                yield return $"{label} backs onto {backingMember}, which is no enum";
            else if (!Enum.GetNames(core).Contains(flag, StringComparer.Ordinal))
                yield return $"{label} names flag {flag}, which {core.Name} does not define";
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

    // A row naming no union base says nothing: the expansion it governs never happens.
    private static IEnumerable<string> UnresolvedUnionBases(ILookup<string, Type> typesByName, string table, HashSet<string> rows)
    {
        foreach (var name in rows.Order(StringComparer.Ordinal))
        {
            if (typesByName[name].FirstOrDefault(t => t.IsClass) is not { } setterType) continue;
            if (!LoquiUnions.IsUnionBase(setterType))
                yield return $"{table}: {name} is no union base, so it expands to no leaves";
        }
    }

    private static IEnumerable<(string TypeName, string MemberName)> Ordinally(IEnumerable<(string TypeName, string MemberName)> rows) =>
        rows.OrderBy(row => row.TypeName, StringComparer.Ordinal).ThenBy(row => row.MemberName, StringComparer.Ordinal);

    // A row no leaf of its union declares hides nothing.
    private IEnumerable<string> UnresolvedUnusedSlotMembers(IReadOnlyList<Type> allTypes, ILookup<string, Type> typesByName)
    {
        foreach (var (typeName, member) in Ordinally(UnusedSlotMembers))
        {
            var label = $"{nameof(UnusedSlotMembers)}: {typeName}.{member}";
            if (typesByName[typeName].FirstOrDefault(t => t.IsClass) is not { } setterType
                || !ReflectedTypes.BaseChain(setterType).Any(t => FunctionUnions.Contains(t.Name)))
                yield return $"{label} names no function union or leaf of one";
            else if (!allTypes.Any(t => t.IsClass && setterType.IsAssignableFrom(t) && t.GetProperty(member) != null))
                yield return $"{label} is declared by no leaf";
        }
    }

    // The row says the game leaves a link Mutagen types non-nullable unset. On a link Mutagen
    // already types nullable, or on something that is no link, it says nothing.
    private IEnumerable<string> UnresolvedPermittedNullLinks(ILookup<string, Type> typesByName)
    {
        foreach (var entry in Ordinally(PermittedNullFormLinks))
        {
            if (Property(typesByName, entry) is not { } prop) continue;
            var label = $"{nameof(PermittedNullFormLinks)}: {entry.TypeName}.{entry.MemberName}";
            if (!ReflectedTypes.IsFormLink(prop.PropertyType))
                yield return $"{label} is no form link ({prop.PropertyType.Name})";
            else if (ReflectedTypes.IsNullableFormLink(prop.PropertyType))
                yield return $"{label} is already a nullable form link, so the row permits nothing";
        }
    }

    // A row reaches every record of its kind, so it holds for each: a kind whose member lives elsewhere
    // would read as covered and stay writable.
    private IEnumerable<string> UnresolvedContainmentMembers(Assembly gameAssembly, ILookup<string, Type> typesByName)
    {
        foreach (var row in ContainmentMembers)
        {
            var label = $"{nameof(ContainmentMembers)}: {row.TypeName}.{row.MemberName}";
            var kinds = typesByName[row.TypeName].Where(t => t.IsInterface).ToList();
            var records = gameAssembly.GetTypes()
                .Where(t => t is { IsClass: true, IsAbstract: false } && kinds.Any(kind => kind.IsAssignableFrom(t)))
                .ToList();
            if (records.Count == 0) yield return $"{label} names an interface no record of this game has";
            foreach (var record in records.Where(r => r.GetProperties().All(p => p.Name != row.MemberName)))
                yield return $"{label}: {record.Name} has no {row.MemberName}";
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

    /// <summary>Resolves every row against the assembly's types and the shapes its members hold, and
    /// throws naming each row that does not resolve or is not the kind of thing its table says it is.</summary>
    internal void Validate(GameCategory category, Assembly gameAssembly)
    {
        var allTypes = gameAssembly.GetTypes()
            .SelectMany(t => t.GetInterfaces().Append(t))
            .Distinct()
            .ToList();
        var typesByName = allTypes.ToLookup(t => t.Name, StringComparer.Ordinal);
        var shapes = MemberShapes(allTypes).ToList();
        var shapeNames = shapes.Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
        var shapeFullNames = shapes.Select(t => t.FullName ?? t.Name).ToHashSet(StringComparer.Ordinal);

        IEnumerable<string> UnresolvedTypes(string concern, IEnumerable<string> entries) =>
            entries.Where(t => !typesByName[t].Any()).Select(t => $"{concern}: {t}");

        string[] missing =
        [
            .. UnresolvedMembers(typesByName, nameof(ExcludedColumns), ExcludedColumns),
            .. UnresolvedMembers(typesByName, nameof(ExcludedMembers), ExcludedMembers),
            .. UnresolvedTypes(nameof(ExcludedUnions), ExcludedUnions),
            .. UnresolvedUnionBases(typesByName, nameof(ExcludedUnions), ExcludedUnions),
            .. UnresolvedTypes(nameof(FunctionUnions), FunctionUnions),
            .. UnresolvedUnionBases(typesByName, nameof(FunctionUnions), FunctionUnions),
            .. UnresolvedUnusedSlotMembers(allTypes, typesByName),
            .. UnresolvedTypes(nameof(CycleTruncations), CycleTruncations),
            .. UnresolvedTypes(nameof(EmptySubSchemaTypes), EmptySubSchemaTypes),
            .. VectorStructTypes.Where(t => !shapeFullNames.Contains(t)).Order(StringComparer.Ordinal)
                .Select(t => $"{nameof(VectorStructTypes)}: {t} is the shape of no member of this game"),
            .. RefusedShapes.Keys.Where(t => !shapeNames.Contains(t)).Order(StringComparer.Ordinal)
                .Select(t => $"{nameof(RefusedShapes)}: {t} is the shape of no member of this game"),
            .. UnresolvedMembers(typesByName, nameof(EnumMemberLabels), EnumMemberLabels.Keys),
            .. UnresolvedEnumLabels(typesByName),
            .. UnresolvedMembers(typesByName, nameof(KnownDefects), KnownDefects.Select(d => (d.TypeName, d.MemberName))),
            .. UnresolvedMembers(typesByName, nameof(PermittedNullFormLinks), PermittedNullFormLinks),
            .. UnresolvedPermittedNullLinks(typesByName),
            .. UnresolvedMembers(typesByName, nameof(PlacedRotations), PlacedRotations),
            .. UnresolvedMembers(typesByName, nameof(SiblingsInUse), SiblingsInUse.Keys),
            .. UnresolvedSiblingRelations(typesByName),
            .. UnresolvedMembers(typesByName, nameof(KeyedArrays), KeyedArrays.Keys),
            .. UnresolvedKeyMembers(typesByName),
            .. UnresolvedTypes(nameof(SyntheticFlagMembers), SyntheticFlagMembers.Keys.Select(k => k.TypeName)),
            .. UnresolvedSyntheticFlags(typesByName),
            .. UnresolvedMembers(typesByName, nameof(RecordHeaderMembers), RecordHeaderMembers.Select(r => (r.TypeName, r.MemberName))),
            .. UnresolvedTypes(nameof(RecordFlagNames), RecordFlagNames.Select(r => r.TypeName)),
            .. RecordFlagNames.Where(r => r.Bit <= 0 || (r.Bit & (r.Bit - 1)) != 0)
                .Select(r => $"{nameof(RecordFlagNames)}: {r.TypeName} names 0x{r.Bit:X}, which is no single bit"),
            .. UnresolvedRecordFlagEnums(typesByName),
            .. new[] { PartialFormCellsDefinedIn }.OfType<string>()
                .Where(p => !Implicits.Get(category.DefaultRelease()).BaseMasters.Contains(ModKey.FromFileName(p)))
                .Select(p => $"{nameof(PartialFormCellsDefinedIn)}: {p} is no base master of {category}"),
            .. UnresolvedMembers(typesByName, nameof(PluginHeaderMembers), PluginHeaderMembers.Select(r => (r.TypeName, r.MemberName))),
            .. UnresolvedContainmentMembers(gameAssembly, typesByName),
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
    internal void ValidateObserved(string gameAssemblyName, WalkObservations observed)
    {
        string[] idle =
        [
            .. CycleTruncations.Where(t => !observed.AppliedTruncations.Contains(t)).Order(StringComparer.Ordinal)
                .Select(t => $"{nameof(CycleTruncations)}: {t} never stops the walk or lets a loop through"),
            .. EmptySubSchemaTypes.Where(t => !observed.EmptySubSchemas.Contains(t)).Order(StringComparer.Ordinal)
                .Select(t => $"{nameof(EmptySubSchemaTypes)}: {t} never comes out empty in the walk"),
            .. RecordFlagNames.Where(r => !observed.NamedFlags.Contains((r.TypeName, r.Bit)))
                .Select(r => $"{nameof(RecordFlagNames)}: {r.TypeName} 0x{r.Bit:X} names no record table's unnamed bit"),
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
    private readonly HashSet<(string TypeName, long Bit)> _namedFlags = [];

    internal IReadOnlySet<string> AppliedTruncations => _appliedTruncations;
    internal IReadOnlySet<string> EmptySubSchemas => _emptySubSchemas;
    internal IReadOnlySet<(string TypeName, long Bit)> NamedFlags => _namedFlags;

    /// <summary>The walk stopped at this truncation, or let a loop through because of it.</summary>
    internal void AppliedTruncation(string getterInterfaceName) => _appliedTruncations.Add(getterInterfaceName);
    internal void CameOutEmpty(string getterInterfaceName) => _emptySubSchemas.Add(getterInterfaceName);
    internal void NamedFlag(string getterInterfaceName, long bit) => _namedFlags.Add((getterInterfaceName, bit));
}
