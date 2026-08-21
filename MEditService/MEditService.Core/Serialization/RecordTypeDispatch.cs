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

    private readonly IReadOnlyDictionary<string, Type?> _byName;
    private readonly IReadOnlySet<Type> _ambiguous;

    private RecordTypeDispatch(IReadOnlyDictionary<string, Type?> byName, IReadOnlySet<Type> ambiguous)
    {
        _byName = byName;
        _ambiguous = ambiguous;
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

        var abstractElements = modType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(p => GroupElementType(p.PropertyType))
            .OfType<Type>()
            .Where(t => t.IsAbstract && !t.IsInterface)
            .Distinct()
            .ToHashSet();

        // Same discovery SchemaReflector runs (concrete major-record types carrying a static
        // GrupRecordType), reused here for the signature spelling of record_type. Deliberately not
        // taken *from* SchemaReflector: that one drops the tables mEdit doesn't surface as record
        // types (land/navm/navi and the REFR-flavour placements), and those records still have
        // documents this codec has to read back.
        var byName = new Dictionary<string, Type?>(StringComparer.OrdinalIgnoreCase);
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
        }

        var ambiguous = byName.Values
            .OfType<Type>()
            .Where(t => IsAmbiguous(t, abstractElements))
            .ToHashSet();

        return new RecordTypeDispatch(byName, ambiguous);
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
