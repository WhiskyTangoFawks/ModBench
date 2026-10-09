using System.Collections.Concurrent;
using System.Reflection;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>One game's record types, answered by name in either spelling: the schema's table, or the
/// class name a document's <c>MutagenObjectType</c> carries.</summary>
public sealed class RecordTypes
{
    private static readonly ConcurrentDictionary<GameCategory, RecordTypes> Models = new();

    private readonly GameCategory _category;
    private readonly Dictionary<string, Type?> _byName = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> _recordTypeByName = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<string> _recordTypes = [];
    private readonly HashSet<Type> _ambiguous;
    private readonly Dictionary<Type, string> _groupByType = [];
    // Valued by the schema table spelling (lowercased GRUP signature), never the CLR name:
    // The store's record-type dictionary is keyed by that spelling only and throws on "Npc".
    private readonly Dictionary<string, List<string>> _typesByGroup = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Type> _blockLevelByName;
    private readonly ContainerMembers _members = ContainerMembers.Derived;

    private RecordTypes(GameRelease release)
    {
        _category = release.ToCategory();

        // An empty mod purely to reach its own CLR type and assembly — the game-generic route to
        // "which groups does this game's mod have", with no game named here (root CLAUDE.md).
        var modType = ModFactory.Activator(ModKey.Null, release).GetType();

        var groupProperties = modType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .SelectMany(p => GroupElementType(p.PropertyType) is not { } elementType
                ? []
                : new[] { (Property: p, ElementType: elementType) })
            .ToList();

        var abstractElements = groupProperties
            .Select(t => t.ElementType)
            .Where(t => t.IsAbstract && !t.IsInterface)
            .Distinct()
            .ToHashSet();

        foreach (var (type, table) in RecordTableName.GrupRecordClassesIn(modType.Assembly))
        {
            _byName[type.Name] = type;

            // A shared signature resolves to whichever type was discovered first, safe only while they
            // are all ambiguous together; if they disagree, null it so the document names itself.
            if (_byName.TryGetValue(table, out var existing) && existing != type)
            {
                if (existing is not null && IsAmbiguous(existing, abstractElements) != IsAmbiguous(type, abstractElements))
                    _byName[table] = null;
            }
            else
            {
                _byName[table] = type;
                _recordTypes.Add(table);
                _recordTypeByName[table] = table;
            }

            // A type with no top-level group at all (a placed ref, a landscape) is held only inside another record.
            var group = type.Name == CellTypeName
                ? CellsGroup
                : groupProperties.FirstOrDefault(gp => gp.ElementType.IsAssignableFrom(type)).Property?.Name;
            if (group is null) continue;

            _groupByType[type] = group;
            if (!_typesByGroup.TryGetValue(group, out var schemaNamesHere))
                _typesByGroup[group] = schemaNamesHere = [];
            schemaNamesHere.Add(table);
        }

        foreach (var (recordClass, table) in RecordTableName.RecordClassesIn(modType.Assembly))
            _recordTypeByName[recordClass.Name] = table;

        _ambiguous = [.. _byName.Values.OfType<Type>().Where(t => IsAmbiguous(t, abstractElements))];

        var exterior = BlockLevelsUnder(_byName.GetValueOrDefault(WorldspaceTypeName), BlockNumberXMember);
        var interior = BlockLevelsUnder(modType.GetProperty(CellsGroup)?.PropertyType, BlockNumberMember);
        ExteriorCellBlockLevels = [.. exterior.Select(level => level.Name)];
        InteriorCellBlockLevels = [.. interior.Select(level => level.Name)];
        _blockLevelByName = exterior.Concat(interior).ToDictionary(level => level.Name, StringComparer.Ordinal);

        EmbeddedSlotNames = _members.EmbeddedSlots
            .Where(slot => slot.Game == _category)
            .Select(slot => slot.Slot)
            .ToHashSet(StringComparer.Ordinal);
    }

    public static RecordTypes For(GameRelease release) =>
        Models.GetOrAdd(release.ToCategory(), _ => new RecordTypes(release));

    /// <summary>Normalizes an overlay reader's type through the BinaryOverlay suffix convention: an
    /// overlay class does not derive from the concrete setter type, so a bare assignability test
    /// would answer "unambiguous" for every record ingest sees.</summary>
    internal bool IsPathAmbiguous(Type runtimeType) =>
        ConcreteFor(runtimeType.Name) is { } concrete
            ? _ambiguous.Contains(concrete)
            : _ambiguous.Any(a => a.IsAssignableFrom(runtimeType));

    /// <summary>Whether a document of this <c>record_type</c> is expected to name its own type.</summary>
    internal bool IsPathAmbiguous(string recordType) =>
        ConcreteFor(recordType) is not { } concrete || _ambiguous.Contains(concrete);

    /// <summary>Null when nothing in the game's schema matches, in which case the codec falls back
    /// to the self-describing read and fails with a named exception.</summary>
    internal Type? ConcreteFor(string recordType) =>
        _byName.TryGetValue(WithoutOverlaySuffix(recordType), out var type) ? type : null;

    /// <summary>The schema table a name answers to, a class that inherits its GRUP signature included.
    /// Null when nothing in the game's schema answers to it.</summary>
    public string? RecordTypeNamed(string? name) =>
        name is not null && _recordTypeByName.TryGetValue(WithoutOverlaySuffix(name), out var table) ? table : null;

    public string RecordTypeOf(IMajorRecordGetter record) => TableOf(record.GetType());

    internal string TableOf(Type recordClass) =>
        RecordTypeNamed(recordClass.Name)
        ?? throw new InvalidOperationException($"'{recordClass.Name}' is no record class a GRUP registers, so no table holds it.");

    /// <summary>The game's cell and worldspace record types.</summary>
    public string Cell => RecordTypeNamed(CellTypeName) ?? throw MissingRecordType(CellTypeName);

    public string Worldspace => RecordTypeNamed(WorldspaceTypeName) ?? throw MissingRecordType(WorldspaceTypeName);

    private InvalidOperationException MissingRecordType(string recordClass) =>
        new($"{_category} names no record type '{recordClass}', and every Bethesda game has one.");

    /// <summary>Whether this is the game's cell — the one record type whose place in the world is its
    /// directory rather than a slot.</summary>
    public bool IsCell(string recordType) => ConcreteFor(recordType)?.Name == CellTypeName;

    /// <summary>Whether this is the game's worldspace — the one record type whose cells sit under its
    /// blocks, in documents of their own.</summary>
    public bool IsWorldspace(string recordType) => ConcreteFor(recordType)?.Name == WorldspaceTypeName;

    /// <summary>The record types with a top-level group of their own to be placed into. A type the game
    /// holds only inside another record has none.</summary>
    public IEnumerable<string> Creatable => _recordTypes.Where(IsCreatable);

    public bool IsCreatable(string recordType) => GroupOf(recordType) is not null;

    /// <summary>The mod's top-level group holding records of this type, as Mutagen names it ("Npcs").
    /// Null for a type held only inside another record, or one that does not resolve.</summary>
    public string? GroupOf(string recordType) =>
        ConcreteFor(recordType) is { } concrete && _groupByType.TryGetValue(concrete, out var group) ? group : null;

    /// <summary>The one record type <paramref name="group"/> holds. Null when it holds several record
    /// classes (Globals), so a record in it names its own type, and for no group.</summary>
    public string? OnlyRecordTypeIn(string group) =>
        _typesByGroup.TryGetValue(group, out var schemaNames) && schemaNames.Count == 1 ? schemaNames[0] : null;

    /// <summary>Whether a record of <paramref name="recordType"/> holds child records: the copy
    /// gestures land one own-fields-only, and replace an existing override in place rather than
    /// refusing.</summary>
    public bool HasChildSlots(string recordType) => ChildSlotsOf(recordType).Count > 0;

    /// <summary>Every member of <paramref name="recordType"/> holding child records, empty for a type
    /// with none.</summary>
    public IReadOnlyList<string> ChildSlotsOf(string? recordType) =>
        ContainerTypeOf(recordType) is { } container && _members.ChildFieldsByType.TryGetValue((_category, container), out var slots)
            ? slots
            : [];

    /// <summary>Whether <paramref name="recordType"/>'s own document carries the children of
    /// <paramref name="slot"/> inline.</summary>
    public bool IsEmbeddedSlot(string recordType, string slot) =>
        ContainerTypeOf(recordType) is { } container && IsEmbeddedSlotOf(container, slot);

    /// <summary>The names of the members serializing their children inline, across every container
    /// of the game.</summary>
    public IReadOnlySet<string> EmbeddedSlotNames { get; }

    /// <summary>The class name a container's slot facts are keyed by. Null for a name no type of the
    /// game answers to.</summary>
    internal string? ContainerTypeOf(string? recordType) =>
        recordType is null ? null : ConcreteFor(recordType)?.Name;

    /// <summary>Whether a member serializes its children inline. A container whose text names no type
    /// of its own accepts any container's embedded slot name, since nothing narrows it.</summary>
    internal bool IsEmbeddedSlotOf(string? containerTypeName, string member) =>
        containerTypeName is null
            ? EmbeddedSlotNames.Contains(member)
            : _members.EmbeddedSlots.Contains((_category, containerTypeName, member));

    internal IReadOnlyList<Type> HeldBy(string containerTypeName, string slot) =>
        _members.HeldTypesBySlot.TryGetValue((_category, containerTypeName, slot), out var held) ? held : [];

    /// <summary>What a slot holds, for a document that does not spell its child's type.</summary>
    internal string? ElementTypeOf(string containerTypeName, string slot) =>
        _members.ElementTypeBySlot.GetValueOrDefault((_category, containerTypeName, slot));

    /// <summary>The block levels a worldspace nests its exterior cells under, outermost first: the
    /// container levels a spatial mint places blank documents for.</summary>
    public IReadOnlyList<string> ExteriorCellBlockLevels { get; }

    /// <summary>The block levels the cells group nests its interior cells under, outermost first —
    /// the container levels whose blank documents label a minted bucket.</summary>
    public IReadOnlyList<string> InteriorCellBlockLevels { get; }

    internal Type? LoquiTypeNamed(string name) =>
        _blockLevelByName.GetValueOrDefault(name) ?? ConcreteFor(name);

    private const string CellTypeName = "Cell";

    // Spelled, not reflected: the mod holds its cells in a list of blocks, not in a group of cells.
    private const string CellsGroup = "Cells";

    private const string WorldspaceTypeName = "Worldspace";

    // The member names below are static because every Bethesda game spells them the same. This one is
    // the one placement key not simply the folder it sits in: a block level's directory is named after
    // coordinates.
    public static string SubBlockChildMember => "Cells";

    public static string BlockChildMember => "SubBlocks";

    public static string BlockNumberXMember => "BlockNumberX";

    public static string BlockNumberYMember => "BlockNumberY";

    /// <summary>A cell's position in its worldspace's grid, which a bare minted ancestor holds none
    /// of.</summary>
    public static string CellGridMember => "Grid";

    /// <summary>One coordinate rather than the exterior pair.</summary>
    public static string BlockNumberMember => "BlockNumber";

    public static string GroupTypeMember => "GroupType";

    /// <summary>The label each interior level carries, positionally matching
    /// <see cref="InteriorCellBlockLevels"/>. Spelled because the enum names an exterior level ending
    /// in the same type name.</summary>
    public static IReadOnlyList<string> InteriorCellBlockGroupTypes { get; } =
        ["InteriorCellBlock", "InteriorCellSubBlock"];

    /// <summary>Mutagen names the class of a record read lazily from a plugin after the record's own
    /// class, with this suffix.</summary>
    internal const string OverlaySuffix = "BinaryOverlay";

    private const string GetterPrefix = "I";
    private const string GetterSuffix = "Getter";

    /// <summary>The record class a runtime type stands for: an overlay reader's "NameBinaryOverlay" and
    /// a schema's "INameGetter" both name "Name".</summary>
    internal static string ClassNameOf(Type type)
    {
        var name = WithoutOverlaySuffix(type.Name);
        return type.IsInterface && name.StartsWith(GetterPrefix, StringComparison.Ordinal) && name.EndsWith(GetterSuffix, StringComparison.Ordinal)
            ? name[GetterPrefix.Length..^GetterSuffix.Length]
            : name;
    }

    private static string WithoutOverlaySuffix(string name) =>
        name.EndsWith(OverlaySuffix, StringComparison.OrdinalIgnoreCase)
            ? name[..^OverlaySuffix.Length]
            : name;

    private static bool IsAmbiguous(Type concrete, HashSet<Type> abstractElements) =>
        abstractElements.Any(a => a.IsAssignableFrom(concrete));

    // A block level is the list element type carrying block coordinates. Found by that shape, not by
    // member name: a worldspace and a block spell the member holding their blocks differently.
    internal static List<Type> BlockLevelsUnder(Type? container, string blockNumberMember)
    {
        var levels = new List<Type>();
        // Stops at a level already walked, so a shape that nests itself ends the walk short of the
        // caller's count check rather than descending forever.
        var walked = new HashSet<Type>();
        for (var level = BlockLevelIn(container, blockNumberMember);
             level != null && walked.Add(level);
             level = BlockLevelIn(level, blockNumberMember))
        {
            levels.Add(level);
        }
        return levels;
    }

    private static Type? BlockLevelIn(Type? container, string blockNumberMember) =>
        container?.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(p => ListElementType(p.PropertyType))
            .FirstOrDefault(element => element?.GetProperty(blockNumberMember) != null);

    private static Type? ListElementType(Type propertyType) =>
        propertyType.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault();

    // Null for a property that is not a group of major records: a mod's Cells is a list group of
    // CellBlock, which is not one.
    private static Type? GroupElementType(Type propertyType) =>
        propertyType.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IGroupGetter<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault(t => typeof(IMajorRecordGetter).IsAssignableFrom(t));
}
