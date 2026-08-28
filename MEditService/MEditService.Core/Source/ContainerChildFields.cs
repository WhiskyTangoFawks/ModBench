using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>
/// Which fields of a container record hold <b>child major records</b> — a Cell's placed refs,
/// landscape and navmeshes, a Worldspace's top cell, a Quest's dialog topics/branches/scenes, a
/// DialogTopic's responses. One table, read by the thing that still needs to know a parent-child
/// relationship exists: the index's <c>container_child</c> rows (#416 S1b), which
/// <see cref="SourceUnitResolver"/> in turn reads to place an embedded child in its owner's file.
/// Compile no longer reads it at all — #454 retired <c>ContainerAssembler</c>, because the tree's own
/// directory nesting <i>is</i> the containment.
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
/// ships, now backed by that sweep rather than by the original investigation's own say-so.
///
/// <para>That sweep is now the <i>only</i> line of defence, and deliberately so (#454). There used to
/// be a second one at compile time — <c>ContainerAssembler</c> refused a source record it could find
/// no parent slot for — but compile no longer places anything: the deserializer reads a record from
/// wherever the tree already puts it, so "unplaceable" is not a state it can reach. A gap in this
/// table now costs an index row (<c>container_child</c>), never a record missing from the compiled
/// binary.</para>
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
    /// <summary>One child located inside a parent's live object graph — the slot it sits in, and the
    /// child itself as a <i>settable</i> record. <see cref="Child"/> is the real object hanging off
    /// the parent, not a copy, which is the whole point: mutating it and reserializing the parent is
    /// how #453 writes an embedded child without a JSON path
    /// (<c>Edits.RecordEditService.EditField</c>).</summary>
    internal readonly record struct EmbeddedChild(string SlotName, int SlotIndex, IMajorRecord Child);

    /// <summary>
    /// <paramref name="formKey"/>'s child record inside <paramref name="parent"/>, or null when
    /// <paramref name="parent"/> does not carry it. This is the answer to #453 scope 1's "at which
    /// JSON path inside the file", given through Mutagen's own object model instead of a JSON
    /// pointer: the child is a real record in the parent's graph, so every existing write mechanism —
    /// <c>RecordFieldWriter</c>, the codecs it dispatches to, the refusal set around it — applies to
    /// it completely unchanged, and there is no second copy of the document's structure to keep in
    /// step with the serializer.
    ///
    /// <para><b>Descends through embedded slots, which reach more than one level deep</b> (#453 review
    /// finding 2 — this used to stop at one, on the stated premise that "anything deeper is its own
    /// source unit with its own file", which is false for exactly one real shape). A worldspace's
    /// <c>RecordData.json</c> embeds its <c>TopCell</c>, and that cell embeds its own placed
    /// references: such a reference is <b>two</b> levels down inside one file, with no file of its own
    /// anywhere. Stopping at one level refused it — and refused it citing an external change that had
    /// not happened.</para>
    ///
    /// <para><b>Descent is bounded to <see cref="SpriggitEmbeddedSlots"/>, and that bound is
    /// correctness rather than thrift.</b> A Quest's dialog topics and scenes are children in this
    /// class's table too, but they are folder-split — each is its own source unit with its own file.
    /// Descending into one and editing it here would write the change into the <i>quest's</i> document
    /// while the child's own file, which is what compile and ingest actually read, kept the old value:
    /// a silently lost edit. So the walk follows containment only as far as the document itself
    /// does.</para>
    /// </summary>
    internal static EmbeddedChild? FindEmbeddedChild(IMajorRecordGetter parent, string formKey) =>
        FindEmbeddedChildSlot(parent, formKey) is { } slot
            ? new EmbeddedChild(slot.SlotName, slot.SlotIndex, slot.Child)
            : null;

    /// <summary>
    /// #461: <paramref name="formKey"/>'s removal from wherever <see cref="FindEmbeddedChild"/> would
    /// have found it — the same <see cref="FindEmbeddedChildSlot"/> traversal, but acting on the match
    /// instead of only reporting it, so a Cell/Worldspace deleted through
    /// <c>Edits.RecordEditService.DeleteRecord</c> comes back with its embedded child genuinely gone
    /// from the object graph that gets reserialized. Returns <see langword="false"/> when nothing
    /// matched (the same "indexed but not actually there" state <see cref="FindEmbeddedChild"/>'s own
    /// callers already have to handle), never throws.
    ///
    /// <para>A list slot (<c>Persistent</c>/<c>Temporary</c>/<c>NavigationMeshes</c>) is spliced by
    /// <see cref="EmbeddedChildSlot.SlotIndex"/>; a single-value slot (<c>Cell.Landscape</c>,
    /// <c>Worldspace.TopCell</c>) is set to <see langword="null"/> outright —
    /// <see cref="EnumerateChildren"/>'s own two cases, mirrored here for the write instead of the
    /// read.</para>
    /// </summary>
    internal static bool RemoveEmbeddedChild(IMajorRecordGetter parent, string formKey)
    {
        if (FindEmbeddedChildSlot(parent, formKey) is not { } slot) return false;

        RemoveFromSlot(slot.Parent, slot.SlotName, slot.SlotIndex);
        return true;
    }

    /// <summary>One child located inside a parent's live object graph, plus the <i>direct</i> parent it
    /// sits in — which is <paramref name="parent"/> itself for a top-level slot, but a nested embedded
    /// record (e.g. a Worldspace's TopCell) when the match is found two levels down. Carrying the direct
    /// parent alongside the slot is what lets <see cref="RemoveEmbeddedChild"/> mutate the right object
    /// without re-deriving it.</summary>
    private readonly record struct EmbeddedChildSlot(IMajorRecordGetter Parent, string SlotName, int SlotIndex, IMajorRecord Child);

    /// <summary>
    /// <paramref name="formKey"/>'s slot inside <paramref name="parent"/>'s object graph, or null when
    /// <paramref name="parent"/> does not carry it. This is the one recursive descent
    /// <see cref="FindEmbeddedChild"/> and <see cref="RemoveEmbeddedChild"/> both need — #461 review:
    /// they used to retype this walk near line-for-line, differing only in what happened at the match;
    /// this is the shared traversal, and each caller now only states what it does with the slot found.
    /// This is the answer to #453 scope 1's "at which JSON path inside the file", given through
    /// Mutagen's own object model instead of a JSON pointer: the child is a real record in the parent's
    /// graph, so every existing write mechanism — <c>RecordFieldWriter</c>, the codecs it dispatches to,
    /// the refusal set around it — applies to it completely unchanged, and there is no second copy of
    /// the document's structure to keep in step with the serializer.
    ///
    /// <para><b>Descends through embedded slots, which reach more than one level deep</b> (#453 review
    /// finding 2 — this used to stop at one, on the stated premise that "anything deeper is its own
    /// source unit with its own file", which is false for exactly one real shape). A worldspace's
    /// <c>RecordData.json</c> embeds its <c>TopCell</c>, and that cell embeds its own placed
    /// references: such a reference is <b>two</b> levels down inside one file, with no file of its own
    /// anywhere. Stopping at one level refused it — and refused it citing an external change that had
    /// not happened.</para>
    ///
    /// <para><b>Descent is bounded to <see cref="SpriggitEmbeddedSlots"/>, and that bound is
    /// correctness rather than thrift.</b> A Quest's dialog topics and scenes are children in this
    /// class's table too, but they are folder-split — each is its own source unit with its own file.
    /// Descending into one and acting on it here would apply the change into the <i>quest's</i>
    /// document while the child's own file, which is what compile and ingest actually read, kept the
    /// old value: a silently lost edit. So the walk follows containment only as far as the document
    /// itself does.</para>
    /// </summary>
    private static EmbeddedChildSlot? FindEmbeddedChildSlot(IMajorRecordGetter parent, string formKey)
    {
        var parentType = NormalizedTypeName(parent.GetType());

        foreach (var (slotName, slotIndex, child) in EnumerateChildren(parent))
        {
            if (child.FormKey.ToString().Equals(formKey, StringComparison.Ordinal))
            {
                // A deserialized parent's children are settable records, so this cast holds for every
                // caller on the write path. Guarded rather than assumed so a read-only graph (a binary
                // overlay, which no write-path caller holds) declines instead of throwing.
                return child is IMajorRecord settable ? new EmbeddedChildSlot(parent, slotName, slotIndex, settable) : null;
            }

            if (!SpriggitEmbeddedSlots.Contains((parentType, slotName))) continue;
            if (FindEmbeddedChildSlot(child, formKey) is { } deeper) return deeper;
        }

        return null;
    }

    /// <summary>
    /// #440: clears every child-major slot <paramref name="record"/>'s object graph actually carries a
    /// value in — the plain "own fields only" half of a shallow Copy as Override on a container (AC3):
    /// xEdit's own Copy as Override always lands own-fields-only for every record type, containers
    /// included — only "Deep copy as override" (#551) keeps children. Built over
    /// <see cref="EnumerateChildren"/>'s own yield rather than <see cref="ByTypeName"/>'s raw field
    /// list, deliberately: that already excludes <c>Worldspace.SubCells</c> (its items are
    /// <c>WorldspaceBlock</c>, not <see cref="IMajorRecordGetter"/>) and, for a Quest or DialogTopic
    /// deserialized from its own <c>RecordData.json</c> alone, yields nothing at all — those folder-
    /// split fields are never inlined into the body to begin with (the codec's own child-folder
    /// suppression), so this is a true no-op for them rather than one that happens to look like it.
    /// </summary>
    internal static void ClearAllChildSlots(IMajorRecordGetter record)
    {
        var slotNames = EnumerateChildren(record).Select(c => c.SlotName).Distinct(StringComparer.Ordinal).ToList();
        foreach (var slotName in slotNames)
        {
            var property = record.GetType().GetProperty(slotName)
                ?? throw new InvalidOperationException(
                    $"{record.GetType().Name} has no property '{slotName}' to clear — ContainerChildFields' table is stale.");

            var value = property.GetValue(record);
            if (value is IMajorRecordGetter) property.SetValue(record, null);
            else ((dynamic)value!).Clear();
        }
    }

    /// <summary>
    /// #440 Slice 6: appends <paramref name="child"/> onto the end of <paramref name="parent"/>'s
    /// <paramref name="slotName"/> list — the write-side counterpart to <see cref="RemoveFromSlot"/>,
    /// for a copy landing a new child into an existing container override (AC2). Only ever a list slot
    /// in practice for this method's one caller (Persistent/Temporary, the placement-tracked embedded
    /// lists) — a single-value slot (Landscape, TopCell) has no "append" to make sense of.
    /// </summary>
    internal static void AddChildToSlot(IMajorRecordGetter parent, string slotName, IMajorRecord child)
    {
        var property = parent.GetType().GetProperty(slotName)
            ?? throw new InvalidOperationException(
                $"{parent.GetType().Name} has no property '{slotName}' to add a child to — ContainerChildFields' table is stale.");

        ((dynamic)property.GetValue(parent)!).Add((dynamic)child);
    }

    /// <summary>The mutation half of <see cref="RemoveEmbeddedChild"/> — reflection rather than a
    /// hand-written switch over each of the four/two concrete slot shapes, for the same reason
    /// <see cref="EnumerateChildren"/> reads them that way: one path that cannot drift from the table
    /// above as new container shapes are added to it. <c>dynamic</c> resolves <c>RemoveAt</c> against
    /// the slot's own runtime list type (<c>ExtendedList&lt;IPlaced&gt;</c>, etc.) — the same DLR
    /// dispatch <see cref="RecordFieldWriter"/>'s own complex-field appliers already rely on
    /// elsewhere in this codebase.</summary>
    private static void RemoveFromSlot(IMajorRecordGetter parent, string slotName, int slotIndex)
    {
        var property = parent.GetType().GetProperty(slotName)
            ?? throw new InvalidOperationException(
                $"{parent.GetType().Name} has no property '{slotName}' to remove a child from — ContainerChildFields' table is stale.");

        var value = property.GetValue(parent);
        if (value is IMajorRecordGetter)
        {
            property.SetValue(parent, null);
            return;
        }

        ((dynamic)value!).RemoveAt(slotIndex);
    }

    /// <summary>
    /// The child slots that serialize <b>inline into their parent's own document</b> rather than to a
    /// file of their own — exactly the set
    /// <see cref="MEditService.Core.Serialization.SpriggitCellEmbedCustomization"/> and
    /// <see cref="MEditService.Core.Serialization.SpriggitWorldspaceEmbedCustomization"/> configure,
    /// restated here as data because <c>EmbedRecordsInSameFile</c> is a generation-time call with
    /// nothing readable at runtime.
    ///
    /// <para><b>A strict subset of <see cref="ByTypeName"/>, and the distinction is the point</b> —
    /// that table names every parent-child relationship, this one names only the relationships that
    /// share a file. <c>Quest.{DialogBranches,DialogTopics,Scenes}</c> and <c>DialogTopic.Responses</c>
    /// are children but stay folder-split, so their absence here is deliberate. Keep this in step with
    /// the two customization classes: they are the source of truth and this is their runtime shadow.
    /// </para>
    /// </summary>
    private static readonly HashSet<(string ParentType, string Slot)> SpriggitEmbeddedSlots =
    [
        ("Cell", "Persistent"), ("Cell", "Temporary"), ("Cell", "Landscape"), ("Cell", "NavigationMeshes"),
        ("Worldspace", "TopCell"),
    ];

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
