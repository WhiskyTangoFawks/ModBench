using System.Collections.Concurrent;
using System.Reflection;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Ledger;

/// <summary>
/// Strips a container record's child-major fields in place before it is ever serialized to the
/// ledger (ADR-0040/#387 amendment): a Cell/Worldspace/Quest/DialogTopic serialized whole spills its
/// children into sibling folders keyed by field name only, which two containers sharing a directory
/// silently cross-contaminate on read. Children are their own ledger entries; the parent's own file
/// carries only the parent's fields.
///
/// <b>Hand-maintained table, not generic reflection — investigated and rejected, not overlooked
/// (#370 Q5 probe).</b> The plausible generic rule — "a property is child-major if its type is (or
/// is a collection of) something implementing <see cref="IMajorRecordGetter"/>" — correctly finds
/// Cell's four fields (Persistent/Temporary/NavigationMeshes are
/// <c>ExtendedList&lt;IPlaced&gt;</c>/<c>ExtendedList&lt;NavigationMesh&gt;</c>, Landscape is a bare
/// <c>Landscape</c> — all major-record-shaped) and Quest's/DialogTopic's fields the same way. It
/// does <b>not</b> find <c>Worldspace.SubCells</c>: reflection confirms its type is
/// <c>ExtendedList&lt;WorldspaceBlock&gt;</c>, and <c>WorldspaceBlock</c> is an intermediate
/// grouping container with no FormKey of its own — it does not implement
/// <see cref="IMajorRecordGetter"/>, so the generic rule silently misses it without a second level
/// of recursion through non-major container types the rule has no principled way to bound (walk one
/// level further for everything, or only for known container shapes — which is the hand list again).
/// Given a real gap rather than a hypothetical one, and that ADR-0040 already hands this ticket the
/// definitive per-type list, the hand-maintained table is what ships — documented here as a decision,
/// not a placeholder.
/// </summary>
internal static class ContainerStripFields
{
    private static readonly Dictionary<string, string[]> ByTypeName = new(StringComparer.Ordinal)
    {
        ["Cell"] = ["Persistent", "Temporary", "NavigationMeshes", "Landscape"],
        ["Worldspace"] = ["TopCell", "SubCells"],
        ["Quest"] = ["DialogBranches", "DialogTopics"],
        ["DialogTopic"] = ["Responses"],
    };

    /// <summary>
    /// Clears (list fields) or nulls (single reference fields, e.g. <c>Landscape</c>/<c>TopCell</c>)
    /// <paramref name="record"/>'s child-major fields in place, if its type is one of the known
    /// container shapes; a no-op for every other type. In place, not a copy, because both callers
    /// hand it something already private to them and about to be serialized and discarded — Track's
    /// freshly deep-parsed record (whose mod is disposed right after), or the deep copy
    /// <see cref="StrippedForSerialization"/> just made for ingest. Nothing else reads the pre-strip
    /// state either way, so there is nothing a copy here would protect. A record re-read from its
    /// own ledger text is already shallow (the ledger never held the children to begin with), so
    /// this is never called on that path.
    /// </summary>
    /// <summary>
    /// The form of <paramref name="record"/> that should be serialized: itself for the ~95% of
    /// records that are not containers, or a stripped deep copy for the ones that are.
    ///
    /// <para>Ingest holds read-only binary-overlay getters, and <see cref="StripInPlace"/> needs a
    /// setter — hence the copy, which is the whole cost of this path and why it is taken only for
    /// container types (measured on a real corpus: 156K of 3.08M records, ~5%). The copy is
    /// <b>necessary</b>, not defensive: suppressing the serializer's per-child streams and folders
    /// keeps the codec off the filesystem but does not stop a populated exterior cell's own stream
    /// from carrying its children — three such cells in the committed cut-down plugin serialize to
    /// 58,419 / 59,070 / 63,281 bytes raw against 12,959 / 16,912 / 15,889 stripped.</para>
    ///
    /// <para>The copy reproduces the deep-parse path's bytes: across all 3,940 records of that
    /// plugin, copy-then-strip agrees with parse-then-strip on 3,939. The one exception is a
    /// reader-fidelity difference, not a stripping one (#369 — Cell <c>092A18</c>'s
    /// <c>Lighting.Versioning</c>), and a deep copy cannot close it because it faithfully copies the
    /// overlay's own divergent values. That residual is the measured, documented hole in
    /// <see cref="GitBlobHash"/>'s one-directional semantics.</para>
    /// </summary>
    internal static IMajorRecordGetter StrippedForSerialization(IMajorRecordGetter record)
    {
        if (!IsContainer(record.GetType())) return record;

        var copy = DeepCopy(record);
        StripInPlace(copy);
        return copy;
    }

    // A binary overlay's runtime type is "<ConcreteName>BinaryOverlay" — the same Mutagen naming
    // convention RecordTextCodec's own dispatch relies on. Normalizing here means the container
    // table above stays keyed by the concrete type name alone and reads the same whether it is
    // handed an overlay getter (ingest) or an already-deep-parsed setter (Track).
    private const string OverlaySuffix = "BinaryOverlay";

    private static bool IsContainer(Type recordType)
    {
        var name = recordType.Name;
        if (name.EndsWith(OverlaySuffix, StringComparison.Ordinal))
            name = name[..^OverlaySuffix.Length];
        return ByTypeName.ContainsKey(name);
    }

    private static readonly ConcurrentDictionary<Type, MethodInfo> DeepCopyMethods = new();

    /// <summary>
    /// Loqui generates a polymorphic <c>DeepCopy</c> on each game's own major-record mixin
    /// (<c>Mutagen.Bethesda.&lt;Game&gt;.&lt;Game&gt;MajorRecordMixIn</c>) which dispatches to the
    /// record's real type — handed a <c>CellBinaryOverlay</c> it returns a <c>Cell</c>, not a
    /// truncated base record. Resolved by reflection from the record type's <i>own namespace</i>
    /// rather than by naming a game, for the same reason the codec's serializer lookup is
    /// (root CLAUDE.md, #413 D5): this runs for every container in every session, so a hardcoded
    /// game would mean a Skyrim or Starfield container silently failing to strip.
    /// </summary>
    private static IMajorRecord DeepCopy(IMajorRecordGetter record)
    {
        var method = DeepCopyMethods.GetOrAdd(record.GetType(), static type =>
        {
            var game = type.Namespace?.Split('.').LastOrDefault()
                ?? throw new InvalidOperationException($"Record type '{type}' has no namespace to derive a game from.");
            var mixInName = $"{type.Namespace}.{game}MajorRecordMixIn";
            var mixIn = type.Assembly.GetType(mixInName)
                ?? throw new InvalidOperationException(
                    $"No '{mixInName}' found in {type.Assembly.GetName().Name} — a container record cannot be " +
                    "copied for stripping, so its document would carry its children.");

            // The two-parameter (getter, TranslationMask) overload; the others take error masks this
            // has no use for.
            return Array.Find(
                       mixIn.GetMethods(BindingFlags.Public | BindingFlags.Static),
                       m => m.Name == "DeepCopy"
                            && m.GetParameters() is { Length: 2 } p
                            && p[0].ParameterType.IsAssignableFrom(type))
                   ?? throw new InvalidOperationException($"'{mixInName}' has no two-parameter DeepCopy overload.");
        });

        return (IMajorRecord)method.Invoke(null, [record, null])!;
    }

    internal static void StripInPlace(IMajorRecord record)
    {
        if (!ByTypeName.TryGetValue(record.GetType().Name, out var fields)) return;

        foreach (var fieldName in fields)
        {
            var property = record.GetType().GetProperty(fieldName)
                ?? throw new InvalidOperationException(
                    $"{record.GetType().Name} has no property '{fieldName}' to strip — ContainerStripFields' table is stale.");

            var current = property.GetValue(record);
            var clear = current?.GetType().GetMethod("Clear", Type.EmptyTypes);
            if (clear != null)
                clear.Invoke(current, null);
            else
                property.SetValue(record, null);
        }
    }
}
