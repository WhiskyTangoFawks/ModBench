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
/// <b>Hand-maintained table, not generic reflection — investigated (#370 Q5), and re-verified by
/// mechanical enumeration (#416, after <c>Quest.Scenes</c> proved the original investigation
/// incomplete: it was checked by inspection, not swept).</b> The rule is "a property is child-major
/// if its type is (or is a collection of) another major record type with no top-level group of its
/// own" — it correctly finds Cell's four fields (Persistent/Temporary/NavigationMeshes are
/// <c>ExtendedList&lt;IPlaced&gt;</c>/<c>ExtendedList&lt;NavigationMesh&gt;</c>, Landscape is a bare
/// <c>Landscape</c>) and Quest's/DialogTopic's fields the same way. It does <b>not</b> find
/// <c>Worldspace.SubCells</c>: reflection confirms its type is
/// <c>ExtendedList&lt;WorldspaceBlock&gt;</c>, and <c>WorldspaceBlock</c> is an intermediate
/// grouping container with no FormKey of its own — it does not implement
/// <see cref="IMajorRecordGetter"/> at all, so the rule correctly excludes it (Worldspace's own
/// nesting is placement/cell_location's job, never this table's).
///
/// <para><see cref="MEditService.Tests.Ledger.ContainerStripFieldsCompletenessTests"/> runs this
/// rule by enumeration over every schema-registered major record type — verified exhaustive as of
/// #416's landing, not merely inspected — and is the standing defence against the next gap (a future
/// Mutagen bump or game module adding a child-major field nobody hand-adds here). Given a real,
/// previously-undetected gap once already (Quest.Scenes), the hand-maintained table is still what
/// ships, now backed by that sweep rather than by the original investigation's own say-so; a ledger
/// record this table still misses refuses at compile time (<c>ContainerAssembler</c>'s completeness
/// guard) rather than corrupting silently, which is the second, independent line of defence.</para>
/// </summary>
internal static class ContainerStripFields
{
    private static readonly Dictionary<string, string[]> ByTypeName = new(StringComparer.Ordinal)
    {
        ["Cell"] = ["Persistent", "Temporary", "NavigationMeshes", "Landscape"],
        ["Worldspace"] = ["TopCell", "SubCells"],
        // "Scenes" (#416): Quest.Scenes is exactly the same child-major shape as DialogBranches/
        // DialogTopics — Scene is IMajorRecordGetter, has no top-level group, and EnumerateMajorRecords
        // already flattens it into its own top-level "scen" row — but it was missing from this table
        // since #370/#387 originally built it. Measured consequence (checked directly against real
        // Track output, both before and after this line landed): NOT document duplication — the
        // codec's own child-record-group deserialization already produces an empty list regardless of
        // what a Quest's own JSON prose says, so nothing here can read a stale inline copy back, and
        // Track's write never inlined one either (DiscardChildRecordStreams suppresses it same as any
        // other child-major field). The actual defect was pure omission: a Scene had no *recorded
        // parent slot anywhere* — the same "index gap" shape as the other four relationships this
        // ticket also closes, not the sixth, different "duplication" shape an earlier draft of this
        // comment claimed from inference rather than measurement. Found once compile's completeness
        // guard tried to attach a Scene to its Quest and had nowhere to put it (the real #369 fixture:
        // 59 Scene records). Corroborated independently by Fallout4ConditionCodecTests' own "Scene is
        // itself IMajorRecordGetter (a 'child record'...)" comment, written for an unrelated feature
        // well before this ticket.
        ["Quest"] = ["DialogBranches", "DialogTopics", "Scenes"],
        ["DialogTopic"] = ["Responses"],
    };

    /// <summary>The exact field-name list <paramref name="recordType"/> strips, or null if it isn't
    /// one of the known container shapes — the read-only accessor <see cref="MEditService.Tests.Ledger.ContainerStripFieldsCompletenessTests"/>
    /// diffs its own swept set against, so the table itself never needs a second public surface.</summary>
    internal static IReadOnlyList<string>? EnumerateStripFieldsFor(Type recordType) =>
        ByTypeName.TryGetValue(NormalizedTypeName(recordType), out var fields) ? fields : null;

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

    private const string OverlaySuffix = "BinaryOverlay";

    private static bool IsContainer(Type recordType) => ByTypeName.ContainsKey(NormalizedTypeName(recordType));

    /// <summary>A binary overlay's runtime type is <c>"&lt;ConcreteName&gt;BinaryOverlay"</c> — the
    /// same Mutagen naming convention <c>RecordTextCodec</c>'s own dispatch relies on. Normalizing
    /// this once means every caller here (and <see cref="MEditService.Core.Records.DuckDbRecordIndex"/>'s
    /// container_child skip-list, #416 S1b) keys off the same name whether handed an overlay getter
    /// (ingest) or an already-deep-parsed setter (Track).</summary>
    internal static string NormalizedTypeName(Type recordType)
    {
        var name = recordType.Name;
        return name.EndsWith(OverlaySuffix, StringComparison.Ordinal) ? name[..^OverlaySuffix.Length] : name;
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

    /// <summary>
    /// The children <paramref name="record"/> loses when <see cref="StripInPlace"/>/
    /// <see cref="StrippedForSerialization"/> clears its container fields — read non-destructively
    /// off a getter, so ingest can capture parentage (#416 S1b's <c>container_child</c> side table)
    /// in the same pass that strips the parent for its own document, with no second walk and no risk
    /// of the strip list and the parentage coverage drifting apart: both are driven by this same
    /// <see cref="ByTypeName"/> table. Yields nothing for a non-container type.
    ///
    /// <para><paramref name="SlotIndex"/>[sic, see below] is the child's position within its own
    /// field (always 0 for a single-reference field like <c>Landscape</c>) — preserved so a compile
    /// can reproduce a stripped list's original order rather than an ingest-arbitrary one.</para>
    /// </summary>
    internal static IEnumerable<(string SlotName, int SlotIndex, IMajorRecordGetter Child)> EnumerateChildren(
        IMajorRecordGetter record)
    {
        if (!ByTypeName.TryGetValue(NormalizedTypeName(record.GetType()), out var fields)) yield break;

        foreach (var fieldName in fields)
        {
            var property = record.GetType().GetProperty(fieldName)
                ?? throw new InvalidOperationException(
                    $"{record.GetType().Name} has no property '{fieldName}' to read children from — ContainerStripFields' table is stale.");

            switch (property.GetValue(record))
            {
                case IMajorRecordGetter single:
                    yield return (fieldName, 0, single);
                    break;
                case System.Collections.IEnumerable list and not string:
                    var i = 0;
                    foreach (var item in list)
                    {
                        if (item is IMajorRecordGetter child)
                            yield return (fieldName, i, child);
                        i++;
                    }
                    break;
            }
        }
    }
}
