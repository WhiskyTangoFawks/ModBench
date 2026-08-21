using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>
/// Which fields of a container record hold <b>child major records</b> — a Cell's placed refs,
/// landscape and navmeshes, a Worldspace's top cell, a Quest's dialog topics/branches/scenes, a
/// DialogTopic's responses. One table, read by the two things that still need to know a parent-child
/// relationship exists: the index's <c>container_child</c> rows (#416 S1b) and compile's
/// <see cref="MEditService.Core.Edits.ContainerAssembler"/>.
///
/// <para><b>This used to be <c>ContainerStripFields</c>, and it no longer strips anything</b> (#450 /
/// ADR-0041's #444 amendment). The shallow-strip posture existed because driving the un-customized
/// per-record serializer over a container spilled its children into sibling folders keyed by field
/// name, which two containers sharing a directory silently cross-contaminated on read (#387). The
/// #444 spike showed that defect is an artifact of that one path — the whole-mod folder-split door
/// does not have it, by construction — so the answer is Spriggit's embed customization, not a strip.
/// A container's document now carries its embedded children, and its children are index rows
/// extracted from it rather than a reason to hollow it out.</para>
///
/// <para><b>Hand-maintained table, not generic reflection — investigated (#370 Q5), and re-verified
/// by mechanical enumeration (#416, after <c>Quest.Scenes</c> proved the original investigation
/// incomplete: it was checked by inspection, not swept).</b> The rule is "a property is child-major
/// if its type is (or is a collection of) another major record type with no top-level group of its
/// own" — it correctly finds Cell's four fields (Persistent/Temporary/NavigationMeshes are
/// <c>ExtendedList&lt;IPlaced&gt;</c>/<c>ExtendedList&lt;NavigationMesh&gt;</c>, Landscape is a bare
/// <c>Landscape</c>) and Quest's/DialogTopic's fields the same way. It does <b>not</b> find
/// <c>Worldspace.SubCells</c>: reflection confirms its type is
/// <c>ExtendedList&lt;WorldspaceBlock&gt;</c>, and <c>WorldspaceBlock</c> is an intermediate
/// grouping container with no FormKey of its own — it does not implement
/// <see cref="IMajorRecordGetter"/> at all, so the rule correctly excludes it (Worldspace's own
/// nesting is placement/cell_location's job, never this table's).</para>
///
/// <para>Note that this table is deliberately <i>wider</i> than the set Spriggit embeds: it names
/// every parent-child relationship, while only <c>Cell.{Persistent,Temporary,Landscape,
/// NavigationMeshes}</c> and <c>Worldspace.TopCell</c> serialize inline (see
/// <see cref="MEditService.Core.Serialization.SpriggitCellEmbedCustomization"/>). One is about
/// containment, the other about file layout; they are not the same list and must not be merged.</para>
///
/// <para><see cref="MEditService.Tests.Source.ContainerChildFieldsCompletenessTests"/> runs the rule
/// by enumeration over every schema-registered major record type — verified exhaustive as of #416's
/// landing, not merely inspected — and is the standing defence against the next gap (a future Mutagen
/// bump or game module adding a child-major field nobody hand-adds here). Given a real,
/// previously-undetected gap once already (Quest.Scenes), the hand-maintained table is still what
/// ships, now backed by that sweep rather than by the original investigation's own say-so; a source
/// record this table still misses refuses at compile time (<c>ContainerAssembler</c>'s completeness
/// guard) rather than corrupting silently, which is the second, independent line of defence.</para>
/// </summary>
internal static class ContainerChildFields
{
    private static readonly Dictionary<string, string[]> ByTypeName = new(StringComparer.Ordinal)
    {
        ["Cell"] = ["Persistent", "Temporary", "NavigationMeshes", "Landscape"],
        ["Worldspace"] = ["TopCell", "SubCells"],
        // "Scenes" (#416): Quest.Scenes is exactly the same child-major shape as DialogBranches/
        // DialogTopics — Scene is IMajorRecordGetter, has no top-level group, and EnumerateMajorRecords
        // already flattens it into its own top-level "scen" row — but it was missing from this table
        // since #370/#387 originally built it. The defect was pure omission: a Scene had no *recorded
        // parent slot anywhere* — the same "index gap" shape as the other four relationships that
        // ticket also closed. Found once compile's completeness guard tried to attach a Scene to its
        // Quest and had nowhere to put it (the real #369 fixture: 59 Scene records). Corroborated
        // independently by Fallout4ConditionCodecTests' own "Scene is itself IMajorRecordGetter (a
        // 'child record'...)" comment, written for an unrelated feature well before that ticket.
        ["Quest"] = ["DialogBranches", "DialogTopics", "Scenes"],
        ["DialogTopic"] = ["Responses"],
    };

    /// <summary>The exact child-major field-name list <paramref name="recordType"/> has, or null if
    /// it isn't one of the known container shapes — the read-only accessor
    /// <see cref="MEditService.Tests.Source.ContainerChildFieldsCompletenessTests"/> diffs its own
    /// swept set against, so the table itself never needs a second public surface.</summary>
    internal static IReadOnlyList<string>? EnumerateChildFieldsFor(Type recordType) =>
        ByTypeName.TryGetValue(NormalizedTypeName(recordType), out var fields) ? fields : null;

    private const string OverlaySuffix = "BinaryOverlay";

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

    /// <summary>
    /// <paramref name="record"/>'s child major records, read non-destructively off a getter, so
    /// ingest can capture parentage (#416 S1b's <c>container_child</c> side table) in the same pass
    /// that writes the parent's own document. Yields nothing for a non-container type.
    ///
    /// <para><c>SlotIndex</c> is the child's position within its own field (always 0 for a
    /// single-reference field like <c>Landscape</c>) — preserved so a compile can reproduce a list's
    /// original order rather than an ingest-arbitrary one.</para>
    /// </summary>
    internal static IEnumerable<(string SlotName, int SlotIndex, IMajorRecordGetter Child)> EnumerateChildren(
        IMajorRecordGetter record)
    {
        if (!ByTypeName.TryGetValue(NormalizedTypeName(record.GetType()), out var fields)) yield break;

        foreach (var fieldName in fields)
        {
            var property = record.GetType().GetProperty(fieldName)
                ?? throw new InvalidOperationException(
                    $"{record.GetType().Name} has no property '{fieldName}' to read children from — ContainerChildFields' table is stale.");

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
