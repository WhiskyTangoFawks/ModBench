using System.Collections;
using System.IO.Abstractions;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>
/// Order is a property of the parent's collection, not of each child (ADR-0042 decision 4). Every
/// folder-split list carries its order as an ordered child list <b>in the parent's own document</b>,
/// and each child file is named by identity alone. Deleting one child of a 13-sibling container is
/// one file deletion plus one line in the parent — never a rename cascade through every later
/// sibling, which is what the superseded <c>"[N] "</c> filename-prefix scheme cost.
///
/// <para><b>Byte-fidelity is unchanged</b> (decision 3): order is still carried losslessly for every
/// folder-split list, and nothing is ever re-sorted. Only the carrier moved.</para>
///
/// <para><b>The walk is order-independent, which is the whole reason one traversal can serve both
/// directions.</b> A carrier's path is built from identity only — a record's
/// <c>[&lt;EditorID&gt; - ]&lt;hex6&gt;_&lt;modKey&gt;</c> leaf
/// (<see cref="SourceUnitResolver.LeafNameFor"/>) and a block's own <c>BlockNumber</c>/<c>X, Y</c>
/// coordinates — never a position. So <see cref="Enumerate"/> finds the same carrier for the same
/// collection whether the model it walks is in the right order (write side, straight off the parsed
/// binary) or in whatever order directory enumeration happened to yield (read side, before this class
/// has fixed it). Without that property the read side would have to know the order to find the file
/// that tells it the order.</para>
///
/// <para><b>Identity in the list is the FormKey, not the file name.</b> Nothing here reconstructs or
/// parses a child's file name to decide order — the list holds what the model itself is keyed by, so
/// an EditorID edit (a rename) never touches a parent's ordered list, and a list entry cannot drift
/// out of agreement with a name this class did not write. Block children, which have no FormKey, use
/// their own coordinates for the same reason.</para>
///
/// <para><b>Two carriers, both verified against the pinned reader rather than assumed.</b> A group's
/// records are carried by that folder's own <c>GroupRecordData.json</c> (minted here when the
/// writer makes none of its own — flat groups like <c>Npcs/</c> have no such file, only
/// <c>Cells/</c> and the block levels do); a record's own member collection
/// (<c>Quest.DialogTopics</c>, <c>DialogTopic.Responses</c>, <c>Worldspace.SubCells</c>) is carried
/// by the owning record's <c>RecordData.json</c>, keyed by member name, because a
/// <c>MajorRecordList</c> folder has no document of its own. The generated reader skips the spliced
/// member in both (<c>DeserializeSingleFieldInto</c>'s <c>default: kernel.Skip(reader)</c>), and a
/// minted <c>GroupRecordData.json</c> in a folder whose children are <c>.json</c> <i>files</i> is not
/// mistaken for one of those records — both confirmed empirically against this project's own
/// Serialization pin, not read off the newer reference clone.</para>
///
/// <para><b>Drift is asymmetric, deliberately.</b> A child on disk the list does not name is refused
/// loudly (<see cref="SourceChildOrderDriftException"/>, naming the parent and the children): nothing
/// can say where it belongs, and inventing a position is a gameplay change for
/// <c>DialogTopic.Responses</c>. A list entry with no file is <i>not</i> refused — it is honoured as a
/// deletion, because deleting the file is how a record is deleted by hand, and ADR-0041's git-native
/// working-tree model makes that a first-class edit. The tree is authoritative for whether a child
/// exists; the parent's list is authoritative for the order of the ones that do.</para>
///
/// <para><b>That makes a hand-deleted record readable, not compilable.</b> The round-trip gate
/// compares the tree against what the codec would reserialize from it, so a list still naming the
/// deleted record refuses the plugin's own next Save &amp; Compile until <see cref="PruneMissing"/>
/// repairs it or the mod is re-Tracked. The superseded numbering scheme had exactly this limit for
/// exactly this case (a hand-deleted file left a numbering gap the compile gate refused); it is
/// ported deliberately, not overlooked.</para>
/// </summary>
internal static class SourceChildOrder
{
    /// <summary>The spliced member's name. Deliberately not a plausible Mutagen field name, so it
    /// cannot ever collide with a real one the generated reader would otherwise bind.</summary>
    internal const string MemberName = "MEditChildOrder";


    // Matches what the whole-mod door's own writer produces, so a carrier this class rewrites is
    // formatted exactly like one it did not (RecordEditService.GroupRecordDataOptions says the same
    // for its own minimal writes).
    private static readonly JsonSerializerOptions CarrierOptions = new() { WriteIndented = true };

    /// <summary>
    /// One folder-split collection: where its order is carried, under what key, its children in the
    /// model's own current order, and how to put them back in a different one.
    ///
    /// <para><paramref name="Rewrite"/> exists because the two collection shapes the writer
    /// folder-splits have no common ordered interface. A record's member list is an
    /// <see cref="IList"/>; a top-level group is a <c>Group&lt;T&gt;</c>, whose order lives in a
    /// FormKey-keyed <c>RecordCache</c> that is not a list at all and is reordered by being emptied
    /// and refilled. Naming the operation instead of the container lets one walk serve both.</para>
    /// </summary>
    private readonly record struct OrderedCollection(
        string CarrierPath,
        string Key,
        IReadOnlyList<object> Children,
        Action<IReadOnlyList<object>> Rewrite)
    {
        internal IReadOnlyList<string> Identities => [.. Children.Select(IdentityOf)];

        /// <summary>What a child is keyed by in its parent's ordered list: its FormKey when it has
        /// one, and its own block coordinates when it does not. Never a file name — see the class
        /// doc.</summary>
        private static string IdentityOf(object child) => child switch
        {
            IMajorRecordGetter record => record.FormKey.ToString(),
            _ => BlockCoordinatesOf(child),
        };
    }

    /// <summary>
    /// The children of a list-shaped member collection, and how to reorder it.
    ///
    /// <para><b>Enumerated through <see cref="IEnumerable"/> but reordered through
    /// <see cref="IList"/>, and the asymmetry is the point.</b> The write side walks whatever mod it
    /// is handed, and a mod parsed as a getter is a <c>BinaryOverlay</c> whose collections are
    /// read-only — they implement <c>IReadOnlyList</c> and not <c>IList</c>. Discovering collections
    /// by asking for <c>IList</c> therefore skipped every one of them on an overlay, silently writing
    /// a tree with no order in it at all. Only the read side ever reorders, and it always holds a
    /// genuinely settable mod, so the cast belongs in the rewrite rather than in the discovery.</para>
    /// </summary>
    private static (IReadOnlyList<object> Children, Action<IReadOnlyList<object>> Rewrite) ListSlot(IEnumerable collection)
    {
        var children = collection.Cast<object>().ToList();
        return (children, ordered =>
        {
            var list = (IList)collection;
            list.Clear();
            foreach (var child in ordered) list.Add(child);
        }
        );
    }

    /// <summary>
    /// The records of a <c>Group&lt;T&gt;</c>, and how to reorder it: empty the record cache and
    /// refill it in the wanted order. Reached reflectively because <c>RecordCache</c>'s own element
    /// type is the group's generic argument, so there is no non-generic interface to call
    /// <c>Clear</c>/<c>Set</c> through, and this class walks every group type in the game uniformly
    /// rather than naming any of them.
    /// </summary>
    private static (IReadOnlyList<object> Children, Action<IReadOnlyList<object>> Rewrite) GroupSlot(object group)
    {
        var children = ((IEnumerable)group).Cast<object>().ToList();

        // Resolved lazily, and against the cache's own generic argument rather than a child's runtime
        // type. Both matter: the write side walks an IModGetter, whose records are BinaryOverlay
        // types that do not derive from the concrete setter type Set takes — picking the overload by
        // asking whether it accepts a child would find nothing there, and it is also the one side
        // that never reorders anything. So the lookup belongs inside the delegate, where it only ever
        // runs on the read side's genuinely-settable mod.
        var cache = group.GetType().GetProperty("RecordCache")!.GetValue(group)!;

        return (children, ordered =>
        {
            var cacheType = cache.GetType();
            var element = cacheType.GetGenericArguments()[0];
            cacheType.GetMethod("Clear", Type.EmptyTypes)!.Invoke(cache, null);
            var set = cacheType.GetMethod("Set", [element])!;
            foreach (var child in ordered) set.Invoke(cache, [child]);
        }
        );
    }

    /// <summary>
    /// The document that carries a folder-split collection's order, and the key it is carried under.
    /// The one place a structural write works out where a parent's ordered child list lives, so a
    /// create, a delete and a renumber cannot each answer it differently.
    /// </summary>
    /// <param name="parentDirectory">The directory the children sit in, for a group or a block level;
    /// the owning record's own directory for a record's member collection.</param>
    /// <param name="parentIsRecord">Whether that directory is a record's own
    /// (<c>RecordData.json</c>) rather than a group or block level's
    /// (<c>GroupRecordData.json</c>).</param>
    internal static string CarrierFor(string parentDirectory, bool parentIsRecord) =>
        Path.Combine(parentDirectory, parentIsRecord ? SourceUnitResolver.RecordDataFileName : SourceUnitResolver.GroupRecordDataFileName);

    /// <summary>
    /// Appends <paramref name="identity"/> to the ordered child list a structural write just added a
    /// file for — a create, or the create half of a renumber. Appending rather than inserting is the
    /// same "new siblings land at the end" rule the superseded numbering scheme had, and it is now a
    /// one-line change to one document instead of a rename cascade.
    ///
    /// <para>Idempotent on the identity: a create that lands a FormKey the list already names leaves
    /// the list alone rather than double-listing it, so a retried or partially-applied write cannot
    /// corrupt the order into a shape <see cref="ApplyTo"/> would refuse.</para>
    /// </summary>
    internal static void Add(string carrierPath, string key, string identity, IFileSystem? fileSystem = null)
        => Mutate(carrierPath, key, fileSystem, list =>
        {
            if (!list.Any(entry => entry!.GetValue<string>().Equals(identity, StringComparison.Ordinal)))
                list.Add(identity);
        });

    /// <summary>
    /// Drops <paramref name="identity"/> from the ordered child list a structural write just deleted
    /// the file of. The whole point of the amendment: the siblings after it are untouched, on disk and
    /// in this list, so a mid-list delete stages as one deletion plus one changed document.
    /// </summary>
    internal static void Remove(string carrierPath, string key, string identity, IFileSystem? fileSystem = null)
        => Mutate(carrierPath, key, fileSystem, list =>
        {
            for (var i = list.Count - 1; i >= 0; i--)
            {
                if (list[i]!.GetValue<string>().Equals(identity, StringComparison.Ordinal)) list.RemoveAt(i);
            }
        });

    /// <summary>
    /// Repoints a list entry from <paramref name="oldIdentity"/> to <paramref name="newIdentity"/>
    /// <b>in place</b> — a renumber changes a child's FormKey, which is what this list is keyed by,
    /// and the record must keep its position while doing so. A remove-then-add would silently move it
    /// to the end, which for <c>DialogTopic.Responses</c> is a gameplay change rather than a cosmetic
    /// one.
    /// </summary>
    internal static void Rename(
        string carrierPath, string key, string oldIdentity, string newIdentity, IFileSystem? fileSystem = null)
        => Mutate(carrierPath, key, fileSystem, list =>
        {
            for (var i = 0; i < list.Count; i++)
            {
                if (list[i]!.GetValue<string>().Equals(oldIdentity, StringComparison.Ordinal)) list[i] = newIdentity;
            }
        });

    /// <summary>
    /// Folds the ordered child lists a scratch level records into the destination level it is being
    /// merged into — every identity the scratch names is appended to the destination's list for the
    /// same key, in scratch order, skipping any the destination already has.
    ///
    /// <para>For <see cref="Edits.SpatialContainerMint"/>, which folds a synthetic one-child-per-level
    /// worldspace subtree into a real one. It reads the keys out of the scratch document rather than
    /// being told them, so the block/sub-block/cell member names live in exactly one place — the model
    /// the walk reflects over — and a merge cannot drift from what <see cref="SpliceInto"/> wrote.</para>
    /// </summary>
    internal static void MergeCarrierInto(
        string scratchDirectory, string destinationDirectory, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? new FileSystem()).File;

        foreach (var carrierName in new[] { SourceUnitResolver.RecordDataFileName, SourceUnitResolver.GroupRecordDataFileName })
        {
            var scratchCarrier = Path.Combine(scratchDirectory, carrierName);
            if (!files.Exists(scratchCarrier)) continue;
            if (ReadCarrier(files, scratchCarrier)[MemberName] is not JsonObject orders) continue;

            foreach (var (key, list) in orders)
            {
                foreach (var entry in (JsonArray)list!)
                {
                    Add(Path.Combine(destinationDirectory, carrierName), key, entry!.GetValue<string>(), fileSystem);
                }
            }
        }
    }

    /// <summary>
    /// Drops <paramref name="identity"/> from whichever ordered child list actually names it, given
    /// only the directory the child sat in. For deletes, which know the child but not which of the
    /// two carrier shapes its parent uses.
    ///
    /// <para><b>Why search rather than derive.</b> The key differs by level in ways a path does not
    /// reveal: a top-level group folder is keyed by its own name (<c>Npcs</c>), a member folder by
    /// its own name too (<c>DialogTopics</c>) but carried one directory up in the owning record's
    /// document, and a block level by a member name (<c>Cells</c>, <c>Items</c>) that is nowhere in
    /// the path at all — <c>Cells/0/0</c> is keyed <c>Cells</c>. Deriving that from the path means
    /// re-encoding the model's own member names in a second place, where a delete could quietly
    /// disagree with <see cref="Walk"/> about them. Asking the document which list holds this child
    /// cannot disagree with the document.</para>
    /// </summary>
    internal static void RemoveByIdentity(string childDirectory, string identity, IFileSystem? fileSystem = null)
    {
        if (SlotHolding(childDirectory, identity, fileSystem) is { } slot)
            Remove(slot.Carrier, slot.Key, identity, fileSystem);
    }

    /// <summary>
    /// Repoints a child's list entry in place without the caller having to know which list holds it —
    /// <see cref="RemoveByIdentity"/>'s counterpart for a renumber, which changes the very FormKey the
    /// list is keyed by and must keep the record's position while doing so.
    /// </summary>
    internal static void RenameByIdentity(
        string childDirectory, string oldIdentity, string newIdentity, IFileSystem? fileSystem = null)
    {
        if (SlotHolding(childDirectory, oldIdentity, fileSystem) is { } slot)
            Rename(slot.Carrier, slot.Key, oldIdentity, newIdentity, fileSystem);
    }

    /// <summary>
    /// The ordered child lists <paramref name="documentPath"/> currently carries, as opaque text to
    /// hand back to <see cref="RestoreOrder"/> — null when it carries none.
    ///
    /// <para><b>A record document is a carrier as well as a record, and the codec only knows about
    /// the record half.</b> Serializing a container over its own <c>RecordData.json</c> writes exactly
    /// the record's own fields — so without capture-and-restore around that write, every point write
    /// to a Quest, Worldspace or DialogTopic silently drops the ordered child list naming its
    /// folder-split children, and the next read refuses the whole tree as drift. Renumbering a quest
    /// reproduced precisely that.</para>
    ///
    /// <para>Split into two calls rather than wrapped around a delegate because the write it spans is
    /// asynchronous: a wrapper would have to either block on the write or restore before it finished,
    /// and the second silently loses the very thing this exists to keep.</para>
    /// </summary>
    internal static string? CaptureOrder(string documentPath, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? new FileSystem()).File;
        return files.Exists(documentPath) ? ReadCarrier(files, documentPath)[MemberName]?.ToJsonString() : null;
    }

    /// <summary>Puts back what <see cref="CaptureOrder"/> took, after the write that would have lost
    /// it. A no-op for the null it returns when a document carries no order, which is most of
    /// them.</summary>
    internal static void RestoreOrder(string documentPath, string? captured, IFileSystem? fileSystem = null)
    {
        if (captured is null) return;

        var files = (fileSystem ?? new FileSystem()).File;
        var document = ReadCarrier(files, documentPath);
        document[MemberName] = JsonNode.Parse(captured);
        files.WriteAllText(documentPath, document.ToJsonString(CarrierOptions));
    }

    /// <summary>The ordered child list <paramref name="carrierPath"/> records under
    /// <paramref name="key"/>, or empty when it records none — the read side of
    /// <see cref="Add"/>/<see cref="Remove"/>/<see cref="Rename"/>, for callers that need to see the
    /// order without reordering a model to get at it.</summary>
    internal static IReadOnlyList<string> ListAt(string carrierPath, string key, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? new FileSystem()).File;
        if (!files.Exists(carrierPath)) return [];
        return ReadCarrier(files, carrierPath)[MemberName]?[key] is not JsonArray list
            ? []
            : [.. list.Select(entry => entry!.GetValue<string>())];
    }

    /// <summary>The carrier and key of the ordered child list naming <paramref name="identity"/>, or
    /// null when no list does — also what a caller needing to record the carrier it is about to
    /// change (a transactional renumber, #678) asks for the path.</summary>
    internal static (string Carrier, string Key)? SlotHolding(
        string childDirectory, string identity, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? new FileSystem()).File;
        var parent = Path.GetDirectoryName(childDirectory);

        string[] candidates = parent is null
            ? [CarrierFor(childDirectory, parentIsRecord: false)]
            : [CarrierFor(childDirectory, parentIsRecord: false), CarrierFor(parent, parentIsRecord: true)];

        foreach (var carrier in candidates)
        {
            if (!files.Exists(carrier)) continue;
            if (ReadCarrier(files, carrier)[MemberName] is not JsonObject orders) continue;

            foreach (var (key, list) in orders)
            {
                if (list is JsonArray array
                    && array.Any(e => e!.GetValue<string>().Equals(identity, StringComparison.Ordinal)))
                {
                    return (carrier, key);
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Drops from <paramref name="carrierPath"/>'s list under <paramref name="key"/> every identity
    /// that no longer has a file or directory in <paramref name="childDirectory"/> — the repair a
    /// structural write performs defensively, because the tree can have been changed without Modbench
    /// (root CLAUDE.md's never-assume-exclusive-ownership rule).
    ///
    /// <para><b>Reads tolerate a stale entry; compile does not, and that is why this exists.</b> A
    /// listed child with no file is honoured as a deletion when reading (see <see cref="ApplyTo"/>),
    /// so the plugin still opens — but the round-trip gate compares the tree against what the codec
    /// would reserialize from it, and a list naming a record that is not there does not match. Left
    /// alone, a hand-deleted file would therefore make the plugin's own next Save &amp; Compile refuse
    /// until a re-Track. This is the direct successor to the group-folder renormalization the
    /// superseded numbering scheme ran for exactly the same reason.</para>
    ///
    /// <para>Presence is tested by asking whether any child's name carries the identity — the same
    /// direction of the filename question <c>SourceUnitResolver</c> already answers safely (given a
    /// FormKey, does this name carry it), never the ambiguous inverse of splitting a name into
    /// EditorID and FormKey.</para>
    /// </summary>
    internal static void PruneMissing(
        string childDirectory, string carrierPath, string key, IFileSystem? fileSystem = null)
    {
        var system = fileSystem ?? new FileSystem();
        if (!system.Directory.Exists(childDirectory)) return;

        var present = system.Directory.EnumerateFileSystemEntries(childDirectory)
            .Select(Path.GetFileName)
            .Select(name => name!)
            .ToList();

        Mutate(carrierPath, key, fileSystem, list =>
        {
            for (var i = list.Count - 1; i >= 0; i--)
            {
                if (!present.Any(name => NameCarriesIdentity(name, list[i]!.GetValue<string>()))) list.RemoveAt(i);
            }
        });
    }

    /// <summary>Whether <paramref name="leaf"/> is the file or directory of the child recorded as
    /// <paramref name="identity"/> — delegated to <see cref="SourceUnitResolver.NameCarriesFormKey"/>
    /// for a record, so the filesafe-FormKey naming rule keeps one owner; a block is named after its
    /// own coordinates, which are the identity itself.</summary>
    private static bool NameCarriesIdentity(string leaf, string identity) =>
        leaf.Equals(identity, StringComparison.Ordinal)
        || (identity.Contains(':', StringComparison.Ordinal)
            && SourceUnitResolver.NameCarriesFormKey(leaf, identity));

    private static void Mutate(string carrierPath, string key, IFileSystem? fileSystem, Action<JsonArray> edit)
    {
        var system = fileSystem ?? new FileSystem();
        var files = system.File;
        var document = ReadCarrier(files, carrierPath);
        var orders = document[MemberName] as JsonObject;
        if (orders is null)
        {
            orders = new JsonObject();
            document[MemberName] = orders;
        }

        // Detached first: a JsonNode already parented cannot be re-assigned into the same document.
        var list = orders[key] as JsonArray ?? new JsonArray();
        var working = new JsonArray();
        foreach (var entry in list) working.Add(entry!.GetValue<string>());

        edit(working);
        orders[key] = working;

        system.Directory.CreateDirectory(Path.GetDirectoryName(carrierPath)!);
        files.WriteAllText(carrierPath, document.ToJsonString(CarrierOptions));
    }

    /// <summary>
    /// Splices every folder-split collection's order into its parent's document, for a tree
    /// <paramref name="mod"/> was just serialized into. Called between the whole-mod door's write and
    /// the enumeration that turns the tree into committed files, so Track and the external-change
    /// absorber get it from the one place they already share.
    /// </summary>
    internal static void SpliceInto(string treeRoot, IModGetter mod, IFileSystem? fileSystem = null)
    {
        var system = fileSystem ?? new FileSystem();
        var files = system.File;
        foreach (var group in Enumerate(treeRoot, mod).GroupBy(c => c.CarrierPath, StringComparer.Ordinal))
        {
            var document = ReadCarrier(files, group.Key);
            var orders = new JsonObject();

            foreach (var collection in group)
            {
                var list = new JsonArray();
                foreach (var identity in collection.Identities) list.Add(identity);
                // A keyless collection is the folder's own single group; a keyed one is a named
                // member of the record whose document this is.
                orders[collection.Key] = list;
            }

            document[MemberName] = orders;
            system.Directory.CreateDirectory(Path.GetDirectoryName(group.Key)!);
            files.WriteAllText(group.Key, document.ToJsonString(CarrierOptions));
        }
    }

    /// <summary>
    /// Restores every folder-split collection to the order its parent's document records, for a
    /// <paramref name="mod"/> just read out of <paramref name="treeRoot"/>. Mandatory, not an
    /// optimisation: identity-only file names leave the reader's own enumeration order undefined, so
    /// a mod is in no meaningful order at all until this has run.
    /// </summary>
    internal static void ApplyTo(string treeRoot, IMod mod, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? new FileSystem()).File;
        foreach (var collection in Enumerate(treeRoot, mod))
        {
            var document = ReadCarrier(files, collection.CarrierPath);
            var recorded = document[MemberName]?[collection.Key] as JsonArray;

            var identities = collection.Identities;
            var wanted = recorded is null ? [] : recorded.Select(entry => entry!.GetValue<string>()).ToList();

            var byIdentity = new Dictionary<string, object>(StringComparer.Ordinal);
            for (var i = 0; i < identities.Count; i++) byIdentity[identities[i]] = collection.Children[i];

            // Present but unlisted: refuse. There is no honest answer for where an unlisted child
            // goes — appending it would invent a position, and for DialogTopic.Responses an invented
            // position is a gameplay change. This is the drift ADR-0042 decision 5 refuses loudly,
            // and re-Track is the recovery.
            var unlisted = identities.Where(i => !wanted.Contains(i, StringComparer.Ordinal)).ToList();
            if (unlisted.Count > 0)
            {
                throw new SourceChildOrderDriftException(
                    $"'{Describe(collection)}' holds {unlisted.Count} folder-split " +
                    $"child(ren) that '{collection.CarrierPath}' does not name: {string.Join(", ", unlisted)}. " +
                    "Nothing can say where they belong in the order — re-Track the plugin to rebuild " +
                    "the tree from its binary.");
            }

            // Listed but absent: honour it as a deletion, do not refuse. Deleting the file *is* how a
            // record is deleted by hand — a git checkout, an agent's script, the user's own editor —
            // and ADR-0041's git-native working-tree model makes that a first-class edit rather than
            // corruption (SourceIngestTests' own deleted-record pair pins both halves: absent at
            // Effective, still answerable at Head). The asymmetry is not a softened rule but the
            // right one: the tree is authoritative for whether a child exists, the parent's list for
            // what order the existing ones are in. Each stays authoritative for its own question.
            collection.Rewrite([.. wanted.Where(byIdentity.ContainsKey).Select(identity => byIdentity[identity])]);

        }
    }

    private static string Describe(OrderedCollection collection) =>
        $"{collection.Key} under {collection.CarrierPath}";

    /// <summary>
    /// Every folder-split collection in <paramref name="mod"/>, paired with the document that carries
    /// its order. Walks the model rather than the tree: the model is what knows the order on the way
    /// out, and on the way back in the paths this builds do not depend on order (see the class doc).
    /// </summary>
    private static IEnumerable<OrderedCollection> Enumerate(string treeRoot, IModGetter mod)
    {
        foreach (var property in GroupProperties(mod.GetType()))
        {
            if (property.GetValue(mod) is not { } group) continue;
            var folder = Path.Combine(treeRoot, property.Name);
            var (records, rewrite) = GroupSlot(group);
            if (records.Count == 0) continue;

            // A top-level group's records live in the group's own folder, whose GroupRecordData.json
            // carries their order.
            yield return new OrderedCollection(
                Path.Combine(folder, SourceUnitResolver.GroupRecordDataFileName), property.Name, records, rewrite);

            foreach (var record in records)
            {
                foreach (var nested in Walk(Path.Combine(folder, LeafOf(record)), record, parentIsRecord: true))
                    yield return nested;
            }
        }
    }

    /// <summary>
    /// Every folder-split collection <paramref name="parent"/> owns, recursively.
    ///
    /// <para><b>Two shapes, and the rule that tells them apart.</b> A collection's children get a
    /// folder named after the member (<c>Quest/DialogTopics/</c>, <c>DialogTopic/Responses/</c>)
    /// <i>only</i> when both the parent and its children are major records. Everywhere a block is
    /// involved on either side, the children sit <b>directly</b> in the parent's own directory with no
    /// intervening member folder — <c>Worldspace.SubCells</c> (record parent, block children),
    /// <c>CellBlock.SubBlocks</c> (block/block), and <c>CellSubBlock.Cells</c> (block parent, record
    /// children) are all written that way. Read off the tree the whole-mod door actually produces, not
    /// inferred from the member types.</para>
    ///
    /// <para>The carrier follows the parent, not the children: a record's own document is
    /// <c>RecordData.json</c>, a block level's is the <c>GroupRecordData.json</c> the writer already
    /// puts at every one of those levels.</para>
    /// </summary>
    private static IEnumerable<OrderedCollection> Walk(string parentDirectory, object parent, bool parentIsRecord)
    {
        var carrier = CarrierFor(parentDirectory, parentIsRecord);

        foreach (var property in FolderSplitProperties(parent.GetType()))
        {
            if (property.GetValue(parent) is not IEnumerable collection) continue;
            var (children, rewrite) = ListSlot(collection);
            if (children.Count == 0) continue;

            yield return new OrderedCollection(carrier, property.Name, children, rewrite);

            var childIsRecord = typeof(IMajorRecordGetter).IsAssignableFrom(ElementOf(property.PropertyType)!);
            var childBase = parentIsRecord && childIsRecord
                ? Path.Combine(parentDirectory, property.Name)
                : parentDirectory;

            foreach (var child in children)
            {
                foreach (var nested in Walk(Path.Combine(childBase, LeafOf(child)), child, childIsRecord))
                    yield return nested;
            }
        }
    }

    /// <summary>
    /// The list members the whole-mod door splits into folders: lists of major records, and the
    /// Cell/Worldspace block wrappers that get a directory level each.
    ///
    /// <para><b>The embedded lists are excluded, and that exclusion is not optional.</b>
    /// <see cref="Serialization.CellEmbedCustomization"/> and
    /// <see cref="Serialization.WorldspaceEmbedCustomization"/> write
    /// <c>Cell.{Temporary,Persistent,NavigationMeshes}</c> inline in the cell's own document, so they
    /// have no folder and no children to order — treating one as folder-split would mint a directory
    /// the reader then fails to find a record in. <c>Cell.Landscape</c> and <c>Worldspace.TopCell</c>
    /// are embedded too but are single records rather than lists, so they never reach this filter.
    /// <c>EmbedCustomizationsAreExcludedFromChildOrderTests</c> fails if that customization ever
    /// embeds a list this set does not name.</para>
    /// </summary>
    private static IEnumerable<PropertyInfo> FolderSplitProperties(Type type) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0
                        && !EmbeddedListMembers.Contains(p.Name)
                        && ElementOf(p.PropertyType) is { } element
                        && (typeof(IMajorRecordGetter).IsAssignableFrom(element) || IsBlock(element)))
            .OrderBy(p => p.Name, StringComparer.Ordinal);

    /// <summary>Mirrors <see cref="Serialization.CellEmbedCustomization"/>'s list members — see
    /// <see cref="FolderSplitProperties"/>. By member name alone because the two names are unique to
    /// Cell among every type this walk reaches.</summary>
    internal static readonly IReadOnlySet<string> EmbeddedListMembers =
        new HashSet<string>(StringComparer.Ordinal) { "Temporary", "Persistent", "NavigationMeshes" };

    /// <summary>A Cell/Worldspace block wrapper — the levels the writer gives a directory to but that
    /// are not records themselves, identified by the coordinates they are named after.</summary>
    private static bool IsBlock(Type element) =>
        element.GetProperty("BlockNumber") is not null || element.GetProperty("BlockNumberX") is not null;

    /// <summary>The directory name a folder-split child is written under. Always a directory: this is
    /// only ever asked of a child the walk descends into, and a child with folder-split children of its
    /// own is a directory by definition.</summary>
    private static string LeafOf(object child) => child switch
    {
        IMajorRecordGetter record => SourceUnitResolver.LeafNameFor(record.FormKey, record.EditorID, isDirectory: true),
        _ => BlockCoordinatesOf(child),
    };

    /// <summary>A block's own directory name, which is also its identity: <c>BlockNumber</c> for the
    /// interior nesting, <c>"X, Y"</c> for the exterior one — the whole-mod door's own naming for
    /// these levels, and both are ordinary model fields rather than anything parsed off disk.</summary>
    private static string BlockCoordinatesOf(object block)
    {
        var type = block.GetType();
        var x = type.GetProperty("BlockNumberX")?.GetValue(block);
        var y = type.GetProperty("BlockNumberY")?.GetValue(block);
        if (x is not null && y is not null) return $"{x}, {y}";

        var sub = type.GetProperty("BlockNumber")?.GetValue(block);
        if (sub is not null) return sub.ToString()!;

        throw new InvalidOperationException(
            $"'{type.Name}' is a folder-split child with neither a FormKey nor block coordinates, so " +
            "its parent's ordered child list has nothing to key it by. This is a gap in " +
            $"{nameof(SourceChildOrder)}, not a corrupt tree.");
    }

    private static IEnumerable<PropertyInfo> GroupProperties(Type type) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0 && typeof(IGroupGetter).IsAssignableFrom(p.PropertyType))
            .OrderBy(p => p.Name, StringComparer.Ordinal);

    /// <summary>The element type of a list-shaped member, or null when the member is not one.
    /// Deliberately tests <see cref="IEnumerable"/> rather than <see cref="IList"/> — see
    /// <see cref="ListSlot"/> for why. Groups are excluded because they are reached at the mod level
    /// with their own carrier, and strings because every string is an enumerable of chars.</summary>
    private static Type? ElementOf(Type type)
    {
        if (type == typeof(string) || !type.IsGenericType) return null;
        if (!typeof(IEnumerable).IsAssignableFrom(type)) return null;
        if (typeof(IGroupGetter).IsAssignableFrom(type)) return null;

        var arguments = type.GetGenericArguments();
        return arguments.Length == 1 ? arguments[0] : null;
    }

    private static JsonObject ReadCarrier(IFile files, string path) =>
        files.Exists(path)
            ? JsonNode.Parse(files.ReadAllText(path)) as JsonObject ?? new JsonObject()
            : new JsonObject();
}

/// <summary>
/// The tree holds a folder-split child its parent's ordered child list does not name. Only that
/// direction: a list entry with <i>no</i> file is honoured as a deletion rather than refused (see
/// <see cref="SourceChildOrder.ApplyTo"/>), so it never reaches this. Hand edits and other tools
/// both produce it (root CLAUDE.md's never-assume-exclusive-ownership rule), and ADR-0042 decision 5
/// gives it the same uniform answer every other format break gets: fail loudly, naming the mismatch,
/// and re-Track to recover. Named rather than a bare invalid-operation because it is thrown on the
/// <i>read</i> path and surfaces through the degradation both readers already have: ingest records it
/// as a <c>PluginLoadFailure</c> naming this type and serves the compiled binary rather than failing
/// the load, and a compile refuses. No endpoint catches it directly and none needs to — a bespoke
/// catch would be scaffolding for a case that already has an answer.
/// </summary>
public sealed class SourceChildOrderDriftException : InvalidOperationException
{
    public SourceChildOrderDriftException() { }

    public SourceChildOrderDriftException(string message) : base(message) { }

    public SourceChildOrderDriftException(string message, Exception innerException)
        : base(message, innerException) { }
}
