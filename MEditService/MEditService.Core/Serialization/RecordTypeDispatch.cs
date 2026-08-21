using System.Collections.Concurrent;
using System.Reflection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Serialization;

/// <summary>
/// Which record types a document's <i>path</i> cannot identify, and how to get from the index's
/// <c>record_type</c> string back to a concrete CLR type — the two facts
/// <see cref="RecordTextCodec"/>'s discriminator policy is built on (#450 / ADR-0041's #444
/// amendment).
///
/// <para><b>The rule, derived not tabulated.</b> The whole-mod folder-split path writes a top-level
/// <c>MutagenObjectType</c> exactly when the group it is writing has an <b>abstract element type</b>
/// — a <c>Group&lt;Global&gt;</c> holds GlobalFloat/GlobalBool/GlobalInt/…, so the file's own name
/// and folder cannot say which. Everything else is written through its concrete
/// <c>&lt;Type&gt;_Serialization.Serialize</c> with no discriminator at all. That fact lives in the
/// game's mod type, so it is read from there by reflection rather than kept in a table this codebase
/// would have to remember to update for a new game or a Mutagen bump.</para>
///
/// <para>Note which types fall out as <i>un</i>ambiguous, and why that is right: <c>Cell</c> has no
/// <c>Group&lt;Cell&gt;</c> at all (a mod's <c>Cells</c> is a list group of <c>CellBlock</c>, which
/// is not a major record), and child records — placed refs, landscapes, navmeshes, dialog responses,
/// scenes — have no top-level group either. Both classes are correctly excluded, matching the
/// whole-mod door's own output byte for byte (<c>DocumentShapeParityTests</c>). An embedded child
/// still carries a discriminator, but that is the kernel's own abstract-<i>field</i> rule
/// (<c>ExtendedList&lt;IPlaced&gt;</c>) firing inside the parent's document, nothing to do with
/// this.</para>
///
/// <para><b>Why the name lookup takes two spellings.</b> <c>record_type</c> is not one vocabulary:
/// ingest stores the schema table name, which <c>SchemaReflector</c> builds from the 4-char GRUP
/// signature (<c>"weap"</c>), while the handful of types it excludes (<c>land</c>/<c>navm</c>/
/// <c>navi</c> and the REFR-flavour placement variants) and Track's own
/// <c>SourceRecordType.Resolve</c> fall back to the lowercased CLR type name
/// (<c>"landscape"</c>, <c>"globalfloat"</c>). Both are keys here. Where a signature covers several
/// concrete types they are all ambiguous anyway, so which one the signature resolves to cannot change
/// a dispatch decision — but a signature whose concrete types <i>disagree</i> about ambiguity is
/// treated as ambiguous, so the self-describing path is the one that catches an unforeseen schema
/// shape rather than a concrete deserializer guessing.</para>
/// </summary>
internal sealed class RecordTypeDispatch
{
    private static readonly ConcurrentDictionary<GameCategory, RecordTypeDispatch> Models = new();

    // #451: the record types the #444 erratum names as staying folder-split (Cell, Worldspace — their
    // embedded slots) or directory-per-record (Quest — DialogTopics/Scenes/DialogBranches) even though
    // each has an ordinary top-level Group<T> a reflection walk would otherwise map to a flat
    // "<Folder>/<name>.json". Each of these gets its own "<Folder>/<name>/RecordData.json" directory
    // instead, which SourceRecordPath's flat layout does not cover — reading that structure is
    // #453/#454's job ("compile/ingest reads structure from the tree"). Named explicitly, not inferred
    // structurally: inferring it would silently start covering a fourth type the day Mutagen's
    // generator picks a directory for one, with nothing here to notice.
    //
    // #453: now valued by the top-level group folder each one's directory sits under, because
    // SourceUnitResolver has to know *where to look* for a container even though there is no flat
    // path to compute. Reflection could supply two of the three (Worldspace/Quest do have an
    // ordinary Group<T>) but not Cell — a mod's `Cells` is a list group of `CellBlock`, which is not
    // a major record, so it never enters `groupProperties` at all (see this class's own doc comment
    // above). Deriving two and hardcoding the third would be the worse shape; all three are named
    // here, for the same "named explicitly, not inferred" reason the type names already are.
    private static readonly Dictionary<string, string> DirectoryPerRecordFolders =
        new(StringComparer.Ordinal) { ["Cell"] = "Cells", ["Worldspace"] = "Worldspaces", ["Quest"] = "Quests" };

    private readonly IReadOnlyDictionary<string, Type?> _byName;
    private readonly IReadOnlySet<Type> _ambiguous;
    private readonly IReadOnlyDictionary<Type, string> _folderByType;
    private readonly IReadOnlyDictionary<string, IReadOnlyList<string>> _typesByFolder;

    private RecordTypeDispatch(
        IReadOnlyDictionary<string, Type?> byName,
        IReadOnlySet<Type> ambiguous,
        IReadOnlyDictionary<Type, string> folderByType,
        IReadOnlyDictionary<string, IReadOnlyList<string>> typesByFolder)
    {
        _byName = byName;
        _ambiguous = ambiguous;
        _folderByType = folderByType;
        _typesByFolder = typesByFolder;
    }

    internal static RecordTypeDispatch For(GameRelease release) =>
        Models.GetOrAdd(release.ToCategory(), _ => Build(release));

    /// <summary>
    /// Whether a record of this <i>runtime</i> type needs a self-describing document. Handed an
    /// overlay reader's own type (<c>GlobalFloatBinaryOverlay</c> — what ingest holds), it normalizes
    /// through the same <c>BinaryOverlay</c> suffix convention <see cref="RecordTextCodec"/>'s
    /// dispatch relies on: an overlay class does not derive from the concrete setter type, so a bare
    /// assignability test against the abstract group element would answer "unambiguous" for every
    /// record ingest ever sees.
    /// </summary>
    internal bool IsPathAmbiguous(Type runtimeType) =>
        ConcreteFor(runtimeType.Name) is { } concrete
            ? _ambiguous.Contains(concrete)
            : _ambiguous.Any(a => a.IsAssignableFrom(runtimeType));

    /// <summary>Whether a document of this <c>record_type</c> is expected to name its own type.</summary>
    internal bool IsPathAmbiguous(string recordType) =>
        ConcreteFor(recordType) is not { } concrete || _ambiguous.Contains(concrete);

    /// <summary>
    /// The concrete record type a <c>record_type</c> string names, or null when nothing in the game's
    /// schema matches it — in which case <see cref="RecordTextCodec"/> falls back to the
    /// self-describing read, which fails with its own named exception rather than silently
    /// constructing the wrong type.
    /// </summary>
    internal Type? ConcreteFor(string recordType) =>
        _byName.TryGetValue(NormalizeOverlayName(recordType), out var type) ? type : null;

    /// <summary>
    /// The whole-mod door's own folder name for a flat (single-file) record of this <c>record_type</c>
    /// — the C# group-property name (<c>"Npcs"</c>, <c>"Weapons"</c>) the source generator writes
    /// verbatim as the directory a record's file sits in (traced to
    /// <c>FolderPerRecordGroupFieldGenerator</c>/<c>GroupParallelHelper</c> in
    /// <c>references/mutagen-serialization</c>). Null for three reasons a caller must treat alike —
    /// "this flat helper cannot answer, ask #453/#454's structure-aware reader instead": the type has
    /// no top-level group at all (a placed ref, a landscape — the same set <see cref="IsPathAmbiguous"/>'s
    /// doc comment already names), the type is one of <see cref="DirectoryPerRecordTypeNames"/> (its
    /// own directory holds a <c>RecordData.json</c>, not a flat file), or <paramref name="recordType"/>
    /// does not resolve to a concrete type at all.
    /// </summary>
    internal string? FolderNameFor(string recordType) =>
        ConcreteFor(recordType) is { } concrete && _folderByType.TryGetValue(concrete, out var folder)
            ? folder
            : null;

    /// <summary>
    /// The top-level group folder a record of this type lives <i>somewhere under</i> — the same answer
    /// as <see cref="FolderNameFor"/> for a flat type, plus the three directory-per-record types it
    /// deliberately refuses (<c>Cell</c> → <c>"Cells"</c>, <c>Worldspace</c> → <c>"Worldspaces"</c>,
    /// <c>Quest</c> → <c>"Quests"</c>). Null for a type with no top-level group at all — a placed ref,
    /// a landscape, a navmesh, a dialog topic, a scene.
    ///
    /// <para><b>This is a search hint, never a path.</b> <see cref="FolderNameFor"/> answers "where
    /// exactly is this record's file"; this answers only "which subtree is it somewhere inside", which
    /// is all <c>SourceUnitResolver</c>'s scan needs and all that can honestly be said about a
    /// container whose block/sub-block nesting lives in the tree rather than in the index. A wrong
    /// answer here costs a miss (a typed refusal), never a wrong write — which is what makes narrowing
    /// the scan safe: measured 0.02 s (<c>Cells</c>) / 0.06 s (<c>Worldspaces</c>) against 0.39 s
    /// unnarrowed on a tree the size of the #444 spike's mega-plugin.</para>
    /// </summary>
    internal string? GroupFolderNameFor(string recordType) =>
        FolderNameFor(recordType)
        ?? (ConcreteFor(recordType) is { } concrete
            && DirectoryPerRecordFolders.TryGetValue(concrete.Name, out var folder) ? folder : null);

    /// <summary>
    /// The inverse of <see cref="FolderNameFor"/>: which <c>record_type</c> a flat folder's own name
    /// names, for <c>SourceRecordPath.TryParse</c>'s reverse direction. Null when the folder maps to
    /// more than one concrete type (an ambiguous group — e.g. <c>Globals</c> holds
    /// GlobalFloat/GlobalBool/…) exactly as <see cref="IsPathAmbiguous(string)"/> already reads that
    /// case: the document is asked to self-describe rather than a wrong concrete type being assumed
    /// from the folder alone. Also null for a folder this game has no group for at all.
    /// </summary>
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

        // Same discovery SchemaReflector runs (concrete major-record types carrying a static
        // GrupRecordType), reused here for the signature spelling of record_type. Deliberately not
        // taken *from* SchemaReflector: that one drops the tables mEdit doesn't surface as record
        // types (land/navm/navi and the REFR-flavour placements), and those records still have
        // documents this codec has to read back.
        var byName = new Dictionary<string, Type?>(StringComparer.OrdinalIgnoreCase);
        var folderByType = new Dictionary<Type, string>();
        // #451 review: keyed by folder, valued by the *schema table name* spelling (the lowercased
        // GRUP signature — matching SchemaReflector.cs's own `recordType.Type.ToLowerInvariant()`),
        // never the bare CLR type name. DuckDbRecordIndex's own record-type dictionary is keyed by
        // that schema spelling only, case-sensitively — the #427 rediscovery sweep handing it "Npc"
        // instead of "npc_" threw KeyNotFoundException, caught running the suite. (That sweep is gone
        // as of #452, but the constraint it exposed is not: SourceIngest.ReconcileHead is the caller
        // that relies on this spelling now.) The codec's own
        // dispatch (RecordTextCodec) tolerates either spelling (ConcreteFor's dual keys), so this
        // narrower, correct spelling costs that caller nothing.
        var typesByFolder = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var type in modType.Assembly.GetTypes())
        {
            if (type.IsAbstract || type.IsInterface) continue;
            if (!typeof(IMajorRecordGetter).IsAssignableFrom(type)) continue;
            if (type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static) is not { } grup) continue;

            byName[type.Name] = type;

            var signature = ((RecordType)grup.GetValue(null)!).Type;
            // A signature several concrete types share resolves to whichever was discovered first,
            // which is safe only because they are all ambiguous together. If that ever stops being
            // true, null it out: an unresolvable name reads as ambiguous, so the document is asked to
            // name itself rather than a wrong concrete type being assumed.
            if (byName.TryGetValue(signature, out var existing) && existing != type)
            {
                if (existing is not null && IsAmbiguous(existing, abstractElements) != IsAmbiguous(type, abstractElements))
                    byName[signature] = null;
            }
            else
            {
                byName[signature] = type;
            }

            // #451: the folder half, keyed off the same discovery pass — every concrete major-record
            // type gets mapped to its owning top-level group property's own name, unless it is one of
            // the directory-per-record types (see DirectoryPerRecordTypeNames) or has no top-level
            // group at all (a placed ref, a landscape — FolderNameFor's own doc comment).
            if (DirectoryPerRecordFolders.ContainsKey(type.Name)) continue;
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
            typesByFolder.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value));
    }

    private static bool IsAmbiguous(Type concrete, HashSet<Type> abstractElements) =>
        abstractElements.Any(a => a.IsAssignableFrom(concrete));

    /// <summary>The major-record element type of a group-shaped property, or null if the property is
    /// not a group of major records (a mod's <c>Cells</c> is a list group of <c>CellBlock</c>, which
    /// is not one, and most of a mod's properties are not groups at all).</summary>
    private static Type? GroupElementType(Type propertyType) =>
        propertyType.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IGroupGetter<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault(t => typeof(IMajorRecordGetter).IsAssignableFrom(t));
}
