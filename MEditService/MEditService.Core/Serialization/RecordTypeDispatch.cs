using System.Collections.Concurrent;
using System.Reflection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Serialization;

/// <summary>Which record types a document's path cannot identify (a group with an abstract element
/// type, read from the mod type by reflection), and how record_type in either spelling (signature
/// or CLR name) maps to a concrete type.</summary>
internal sealed class RecordTypeDispatch
{
    private static readonly ConcurrentDictionary<GameCategory, RecordTypeDispatch> Models = new();

    // Named explicitly, not inferred: inference would cover a third type the day Mutagen's generator
    // picks a directory for one. Valued by group folder because reflection cannot supply Cell's. A
    // quest is flat: every child slot is embedded.
    private static readonly Dictionary<string, string> DirectoryPerRecordFolders =
        new(StringComparer.Ordinal) { ["Cell"] = "Cells", ["Worldspace"] = "Worldspaces" };

    private readonly IReadOnlyDictionary<string, Type?> _byName;
    private readonly IReadOnlySet<Type> _ambiguous;
    private readonly IReadOnlyDictionary<Type, string> _folderByType;
    private readonly IReadOnlyDictionary<string, IReadOnlyList<string>> _typesByFolder;
    private readonly IReadOnlyDictionary<string, string> _directoryPerRecordTypeByFolder;

    private RecordTypeDispatch(
        IReadOnlyDictionary<string, Type?> byName,
        IReadOnlySet<Type> ambiguous,
        IReadOnlyDictionary<Type, string> folderByType,
        IReadOnlyDictionary<string, IReadOnlyList<string>> typesByFolder,
        IReadOnlyDictionary<string, string> directoryPerRecordTypeByFolder)
    {
        _byName = byName;
        _ambiguous = ambiguous;
        _folderByType = folderByType;
        _typesByFolder = typesByFolder;
        _directoryPerRecordTypeByFolder = directoryPerRecordTypeByFolder;
    }

    internal static RecordTypeDispatch For(GameRelease release) =>
        Models.GetOrAdd(release.ToCategory(), _ => Build(release));

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
        _byName.TryGetValue(NormalizeOverlayName(recordType), out var type) ? type : null;

    /// <summary>The group-property name ("Npcs") the generator writes verbatim as a flat record's
    /// directory. Null for a type with no top-level group, a directory-per-record one, or one that
    /// does not resolve — ask the repository.</summary>
    internal string? FolderNameFor(string recordType) =>
        ConcreteFor(recordType) is { } concrete && _folderByType.TryGetValue(concrete, out var folder)
            ? folder
            : null;

    /// <summary>A search hint, never a path: which subtree a record is somewhere inside, including
    /// the two directory-per-record types <see cref="FolderNameFor"/> refuses. A wrong answer costs
    /// a miss, never a wrong write.</summary>
    internal string? GroupFolderNameFor(string recordType) =>
        FolderNameFor(recordType)
        ?? (ConcreteFor(recordType) is { } concrete
            && DirectoryPerRecordFolders.TryGetValue(concrete.Name, out var folder) ? folder : null);

    /// <summary>The group folders whose records get a directory rather than a file. Every such
    /// record's directory sits somewhere under one of them, so a scan of all of them finds it without
    /// being told which.</summary>
    internal IEnumerable<string> DirectoryPerRecordFolderNames => _directoryPerRecordTypeByFolder.Keys;

    /// <summary>The record type of a directory in <paramref name="groupFolder"/>, and a cell when
    /// <paramref name="nested"/>: only a cell's directory sits below block levels. Null for any other
    /// folder.</summary>
    internal string? DirectoryPerRecordTypeIn(string groupFolder, bool nested)
    {
        if (!_directoryPerRecordTypeByFolder.ContainsKey(groupFolder)) return null;

        var folder = nested ? DirectoryPerRecordFolders[NestedDirectoryPerRecordType] : groupFolder;
        return _directoryPerRecordTypeByFolder.TryGetValue(folder, out var recordType) ? recordType : null;
    }

    private const string NestedDirectoryPerRecordType = "Cell";

    /// <summary>The one placement key not simply the folder it sits in: a block level's directory is
    /// named after coordinates. Here because this layer owns game-specific naming; static because
    /// every Bethesda game spells it the same.</summary>
    internal static string SubBlockChildMember => "Cells";

    /// <summary>Static for the same reason as <see cref="SubBlockChildMember"/>.</summary>
    internal static string BlockChildMember => "SubBlocks";

    /// <summary>Null when the folder maps to more than one concrete type (an ambiguous group such as
    /// Globals), so the document self-describes rather than a wrong type being assumed, and for a
    /// folder with no group.</summary>
    internal string? RecordTypeForFolder(string folderName) =>
        _typesByFolder.TryGetValue(folderName, out var schemaNames) && schemaNames.Count == 1 ? schemaNames[0] : null;

    private const string OverlaySuffix = "BinaryOverlay";

    private static string NormalizeOverlayName(string name) =>
        name.EndsWith(OverlaySuffix, StringComparison.OrdinalIgnoreCase)
            ? name[..^OverlaySuffix.Length]
            : name;

    private static RecordTypeDispatch Build(GameRelease release)
    {
        // An empty mod purely to reach its own CLR type and assembly — the game-generic route to
        // "which groups does this game's mod have", with no game named here (root CLAUDE.md).
        var modType = ModFactory.Activator(ModKey.Null, release).GetType();

        var groupProperties = modType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(p => (Property: p, ElementType: GroupElementType(p.PropertyType)))
            .Where(t => t.ElementType != null)
            .Select(t => (t.Property, ElementType: t.ElementType!))
            .ToList();

        var abstractElements = groupProperties
            .Select(t => t.ElementType)
            .Where(t => t.IsAbstract && !t.IsInterface)
            .Distinct()
            .ToHashSet();

        // Same discovery SchemaReflector runs, but not taken from it: that one drops the tables mEdit
        // doesn't surface (land/navm/navi, REFR-flavour placements), whose documents still need reading.
        var byName = new Dictionary<string, Type?>(StringComparer.OrdinalIgnoreCase);
        var folderByType = new Dictionary<Type, string>();
        // Valued by the schema table spelling (lowercased GRUP signature), never the CLR name:
        // DuckDbRecordIndex's record-type dictionary is keyed by that spelling only and throws on "Npc".
        var typesByFolder = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var directoryPerRecordTypeByFolder = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var type in modType.Assembly.GetTypes())
        {
            if (type.IsAbstract || type.IsInterface) continue;
            if (!typeof(IMajorRecordGetter).IsAssignableFrom(type)) continue;
            if (type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static) is not { } grup) continue;

            byName[type.Name] = type;

            var signature = ((RecordType)grup.GetValue(null)!).Type;
            // A shared signature resolves to whichever type was discovered first, safe only while they
            // are all ambiguous together; if they disagree, null it so the document names itself.
            if (byName.TryGetValue(signature, out var existing) && existing != type)
            {
                if (existing is not null && IsAmbiguous(existing, abstractElements) != IsAmbiguous(type, abstractElements))
                    byName[signature] = null;
            }
            else
            {
                byName[signature] = type;
            }

            // Every concrete type maps to its owning top-level group, unless it is directory-per-record
            // or has no top-level group at all (a placed ref, a landscape).
            if (DirectoryPerRecordFolders.TryGetValue(type.Name, out var ownFolder))
            {
                directoryPerRecordTypeByFolder[ownFolder] = signature.ToLowerInvariant();
                continue;
            }
            var owningFolder = groupProperties.FirstOrDefault(gp => gp.ElementType.IsAssignableFrom(type)).Property?.Name;
            if (owningFolder is null) continue;

            folderByType[type] = owningFolder;
            if (!typesByFolder.TryGetValue(owningFolder, out var schemaNamesHere))
                typesByFolder[owningFolder] = schemaNamesHere = [];
            schemaNamesHere.Add(signature.ToLowerInvariant());
        }

        var ambiguous = byName.Values
            .OfType<Type>()
            .Where(t => IsAmbiguous(t, abstractElements))
            .ToHashSet();

        return new RecordTypeDispatch(
            byName,
            ambiguous,
            folderByType,
            typesByFolder.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value),
            directoryPerRecordTypeByFolder);
    }

    private static bool IsAmbiguous(Type concrete, HashSet<Type> abstractElements) =>
        abstractElements.Any(a => a.IsAssignableFrom(concrete));

    // Null for a property that is not a group of major records: a mod's Cells is a list group of
    // CellBlock, which is not one.
    private static Type? GroupElementType(Type propertyType) =>
        propertyType.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IGroupGetter<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault(t => typeof(IMajorRecordGetter).IsAssignableFrom(t));
}
