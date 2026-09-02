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
/// <para><b>Drift fails loudly</b> (decision 5's pattern, no new invention): a child on disk the list
/// does not name, or a list entry with no child, is a named
/// <see cref="SourceChildOrderDriftException"/> naming the parent and the mismatch. Hand edits and
/// external tools produce it; re-Track is the recovery.</para>
/// </summary>
internal static class SourceChildOrder
{
    /// <summary>The spliced member's name. Deliberately not a plausible Mutagen field name, so it
    /// cannot ever collide with a real one the generated reader would otherwise bind.</summary>
    internal const string MemberName = "MEditChildOrder";

    private const string GroupRecordDataFileName = "GroupRecordData.json";
    private const string RecordDataFileName = "RecordData.json";

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
        string? Key,
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

    /// <summary>The children of an <see cref="IList"/>-shaped member collection, and how to reorder
    /// it.</summary>
    private static (IReadOnlyList<object> Children, Action<IReadOnlyList<object>> Rewrite) ListSlot(IList list)
    {
        var children = list.Cast<object>().ToList();
        return (children, ordered =>
        {
            list.Clear();
            foreach (var child in ordered) list.Add(child);
        });
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
        });
    }

    /// <summary>
    /// Splices every folder-split collection's order into its parent's document, for a tree
    /// <paramref name="mod"/> was just serialized into. Called between the whole-mod door's write and
    /// the enumeration that turns the tree into committed files, so Track and the external-change
    /// absorber get it from the one place they already share.
    /// </summary>
    internal static void SpliceInto(string treeRoot, IModGetter mod, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? new FileSystem()).File;
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
                orders[collection.Key ?? string.Empty] = list;
            }

            document[MemberName] = orders;
            (fileSystem ?? new FileSystem()).Directory.CreateDirectory(Path.GetDirectoryName(group.Key)!);
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
            var recorded = document[MemberName]?[collection.Key ?? string.Empty] as JsonArray;

            if (recorded is null)
            {
                throw new SourceChildOrderDriftException(
                    $"'{Describe(collection)}' has {collection.Children.Count} folder-split " +
                    $"children on disk, but '{collection.CarrierPath}' records no order for them. " +
                    "The tree was not written by this version of Modbench, or was edited by hand — re-Track it.");
            }

            var wanted = recorded.Select(entry => entry!.GetValue<string>()).ToList();
            var identities = collection.Identities;
            var byIdentity = new Dictionary<string, object>(StringComparer.Ordinal);
            for (var i = 0; i < identities.Count; i++) byIdentity[identities[i]] = collection.Children[i];

            var missing = wanted.Where(w => !byIdentity.ContainsKey(w)).ToList();
            var extra = identities.Where(i => !wanted.Contains(i, StringComparer.Ordinal)).ToList();
            if (missing.Count > 0 || extra.Count > 0)
            {
                throw new SourceChildOrderDriftException(
                    $"'{Describe(collection)}' does not match the ordered child list in " +
                    $"'{collection.CarrierPath}'. " +
                    (missing.Count > 0 ? $"Listed but absent from the tree: {string.Join(", ", missing)}. " : string.Empty) +
                    (extra.Count > 0 ? $"Present in the tree but unlisted: {string.Join(", ", extra)}. " : string.Empty) +
                    "Re-Track the plugin to rebuild the tree from its binary.");
            }

            collection.Rewrite([.. wanted.Select(identity => byIdentity[identity])]);
        }
    }

    private static string Describe(OrderedCollection collection) =>
        collection.Key is null ? collection.CarrierPath : $"{collection.Key} under {collection.CarrierPath}";

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
                Path.Combine(folder, GroupRecordDataFileName), property.Name, records, rewrite);

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
        var carrier = Path.Combine(
            parentDirectory, parentIsRecord ? RecordDataFileName : GroupRecordDataFileName);

        foreach (var property in FolderSplitProperties(parent.GetType()))
        {
            if (property.GetValue(parent) is not IList list || list.Count == 0) continue;
            var (children, rewrite) = ListSlot(list);

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

    private static Type? ElementOf(Type type) =>
        !type.IsGenericType || !typeof(IList).IsAssignableFrom(type) ? null : type.GetGenericArguments().FirstOrDefault();

    private static JsonObject ReadCarrier(IFile files, string path) =>
        files.Exists(path)
            ? JsonNode.Parse(files.ReadAllText(path)) as JsonObject ?? new JsonObject()
            : new JsonObject();
}

/// <summary>
/// The tree's folder-split children and the ordered child lists in their parents' documents do not
/// agree — a file the list does not name, or a list entry with no file. Hand edits and other tools
/// both produce it (root CLAUDE.md's never-assume-exclusive-ownership rule), and ADR-0042 decision 5
/// gives it the same uniform answer every other format break gets: fail loudly, naming the mismatch,
/// and re-Track to recover. Named rather than a bare invalid-operation so the endpoint layer can map
/// it, exactly as <see cref="SourceRoundTripFailedException"/> is.
/// </summary>
public sealed class SourceChildOrderDriftException : InvalidOperationException
{
    public SourceChildOrderDriftException() { }

    public SourceChildOrderDriftException(string message) : base(message) { }

    public SourceChildOrderDriftException(string message, Exception innerException)
        : base(message, innerException) { }
}
