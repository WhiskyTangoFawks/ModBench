using System.Collections;
using System.IO.Abstractions;
using System.Reflection;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>Order is parent data (ADR-0042 decision 4): the parent's document carries the list; files
/// are named by identity alone. Drift is asymmetric: an unlisted child is refused; a listed entry
/// with no file is a deletion.</summary>
internal static class SourceChildOrder
{
    /// <summary>The name of the member a carrier document holds its ordered child lists under.
    /// Deliberately not a plausible Mutagen field name, so it cannot ever collide with a real one
    /// the generated reader would otherwise bind.</summary>
    internal const string OrderMember = "MEditChildOrder";

    private static readonly IFileSystem Disk = new FileSystem();

    // UnsafeRelaxedJsonEscaping is load-bearing: these rewrite whole documents Newtonsoft produced, and
    // the default encoder escapes ', &, <, > and non-ASCII where Newtonsoft does not, breaking byte
    // parity.
    private static readonly JsonSerializerOptions CarrierOptions =
        new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    // Rewrite is an action, not a container: a member list is an IList, a group's order lives in a
    // RecordCache that is emptied and refilled.
    private readonly record struct OrderedCollection(
        string CarrierPath,
        string Key,
        IReadOnlyList<object> Children,
        Action<IReadOnlyList<object>> Rewrite)
    {
        internal IReadOnlyList<string> Identities => [.. Children.Select(IdentityOf)];

        // Keyed by FormKey, or block coordinates for a block; never a file name.
        private static string IdentityOf(object child) => child switch
        {
            IMajorRecordGetter record => record.FormKey.ToString(),
            _ => BlockCoordinatesOf(child),
        };
    }

    // Discovered through IEnumerable, reordered through IList: an overlay's collections are read-only,
    // and only the read side (a settable mod) ever reorders.
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

    // RecordCache's element type is the group's generic argument, so there is no non-generic interface
    // to call through.
    private static (IReadOnlyList<object> Children, Action<IReadOnlyList<object>> Rewrite) GroupSlot(object group)
    {
        var children = ((IEnumerable)group).Cast<object>().ToList();

        return (children, ordered =>
        {
            // Reflection over RecordCache, not IGroup/IClearable: IGroup.SetUntyped recurses infinitely at this
            // pin, and IClearable.Clear wipes the group's own metadata (LastModified) alongside its records.
            // Both observed; do not "simplify" this.
            var cache = group.GetType().GetProperty("RecordCache")!.GetValue(group)!;
            var cacheType = cache.GetType();
            var element = cacheType.GetGenericArguments()[0];
            cacheType.GetMethod("Clear", Type.EmptyTypes)!.Invoke(cache, null);
            var set = cacheType.GetMethod("Set", [element])!;
            foreach (var child in ordered) set.Invoke(cache, [child]);
        }
        );
    }

    /// <summary>The document carrying a folder-split collection's order: the owning record's
    /// <c>RecordData.json</c> for a member collection, the level's own <c>GroupRecordData.json</c> for
    /// a group or block.</summary>
    internal static string CarrierFor(string parentDirectory, bool parentIsRecord) =>
        Path.Combine(parentDirectory, parentIsRecord ? SourceUnitResolver.RecordDataFileName : SourceUnitResolver.GroupRecordDataFileName);

    /// <summary>Appends: new siblings land at the end. Idempotent on the identity, so a retried write
    /// cannot double-list a FormKey into a shape <see cref="ApplyTo"/> would refuse.</summary>
    internal static void Add(string carrierPath, string key, string identity, IFileSystem? fileSystem = null)
        => Mutate(carrierPath, key, fileSystem, list =>
        {
            if (!list.Any(entry => entry!.GetValue<string>().Equals(identity, StringComparison.Ordinal)))
                list.Add(identity);
        });

    /// <summary>Drops the identity; siblings are untouched, so a mid-list delete is one deletion plus one
    /// changed document.</summary>
    internal static void Remove(string carrierPath, string key, string identity, IFileSystem? fileSystem = null)
        => Mutate(carrierPath, key, fileSystem, list =>
        {
            for (var i = list.Count - 1; i >= 0; i--)
            {
                if (list[i]!.GetValue<string>().Equals(identity, StringComparison.Ordinal)) list.RemoveAt(i);
            }
        });

    /// <summary>Repoints an entry in place: a renumber changes the FormKey the list is keyed by, and a
    /// remove-then-add would move the record to the end — a gameplay change for
    /// <c>DialogTopic.Responses</c>.</summary>
    internal static void Rename(
        string carrierPath, string key, string oldIdentity, string newIdentity, IFileSystem? fileSystem = null)
        => Mutate(carrierPath, key, fileSystem, list =>
        {
            for (var i = 0; i < list.Count; i++)
            {
                if (list[i]!.GetValue<string>().Equals(oldIdentity, StringComparison.Ordinal)) list[i] = newIdentity;
            }
        });

    /// <summary>Appends every identity a scratch level names to the destination's list for the same key,
    /// skipping any already present. Keys are read from the scratch document, so member names live in
    /// one place.</summary>
    internal static void MergeCarrierInto(
        string scratchDirectory, string destinationDirectory, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? Disk).File;

        foreach (var carrierName in new[] { SourceUnitResolver.RecordDataFileName, SourceUnitResolver.GroupRecordDataFileName })
        {
            var scratchCarrier = Path.Combine(scratchDirectory, carrierName);
            if (!files.Exists(scratchCarrier)) continue;
            if (ReadCarrier(files, scratchCarrier)[OrderMember] is not JsonObject orders) continue;

            foreach (var (key, list) in orders)
            {
                var identities = ((JsonArray)list!).Select(entry => entry!.GetValue<string>()).ToList();
                Mutate(Path.Combine(destinationDirectory, carrierName), key, fileSystem, destination =>
                {
                    var present = destination.Select(entry => entry!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
                    foreach (var identity in identities.Where(present.Add)) destination.Add(identity);
                });
            }
        }
    }

    /// <summary>For deletes, which know the child but not its parent's carrier shape. Searched, not
    /// derived: a block level's key (Cells, Items) is nowhere in the path, and the document cannot
    /// disagree with itself.</summary>
    internal static void RemoveByIdentity(string childrenDirectory, string identity, IFileSystem? fileSystem = null)
    {
        if (SlotHolding(childrenDirectory, identity, fileSystem) is { } slot)
            Remove(slot.Carrier, slot.Key, identity, fileSystem);
    }

    /// <summary>The record bytes plus the ordered child lists on disk: the codec knows only the record
    /// half, so a point write would drop its lists. Returned as bytes so the caller keeps one atomic
    /// write.</summary>
    internal static byte[] CarryOrderInto(byte[] freshBytes, string documentPath, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? Disk).File;
        if (!files.Exists(documentPath)) return freshBytes;
        if (ReadCarrier(files, documentPath)[OrderMember] is not { } carried) return freshBytes;

        var document = JsonNode.Parse(freshBytes) as JsonObject ?? new JsonObject();
        document[OrderMember] = carried.DeepClone();
        return Encoding.UTF8.GetBytes(document.ToJsonString(CarrierOptions));
    }

    /// <summary>The same merge over text a caller already holds: a document edit reads the file, so
    /// the lists it carried travel back in through here rather than a second read of the disk.</summary>
    internal static string WithOrder(string documentText, JsonNode order)
    {
        var document = JsonNode.Parse(documentText) as JsonObject ?? new JsonObject();
        document[OrderMember] = order.DeepClone();
        return document.ToJsonString(CarrierOptions);
    }

    /// <summary>The record's own fields alone, which is what the index holds as a body — for read-side
    /// compares that would otherwise read every container with children as changed.</summary>
    internal static string WithoutOrder(string documentText)
    {
        if (!documentText.Contains(OrderMember, StringComparison.Ordinal)) return documentText;
        if (JsonNode.Parse(documentText) is not JsonObject document || !document.Remove(OrderMember)) return documentText;
        return document.ToJsonString(CarrierOptions);
    }

    /// <summary>The list under <paramref name="key"/>, or empty — the read side of the mutators, needing
    /// no model.</summary>
    internal static IReadOnlyList<string> ListAt(string carrierPath, string key, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? Disk).File;
        if (!files.Exists(carrierPath)) return [];
        return ReadCarrier(files, carrierPath)[OrderMember]?[key] is not JsonArray list
            ? []
            : [.. list.Select(entry => entry!.GetValue<string>())];
    }

    /// <summary>The carrier and key of the list naming <paramref name="identity"/>, or null when no list
    /// does.</summary>
    internal static (string Carrier, string Key)? SlotHolding(
        string childrenDirectory, string identity, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? Disk).File;
        var parent = Path.GetDirectoryName(childrenDirectory);

        string[] candidates = parent is null
            ? [CarrierFor(childrenDirectory, parentIsRecord: false)]
            : [CarrierFor(childrenDirectory, parentIsRecord: false), CarrierFor(parent, parentIsRecord: true)];

        foreach (var carrier in candidates)
        {
            if (!files.Exists(carrier)) continue;
            if (ReadCarrier(files, carrier)[OrderMember] is not JsonObject orders) continue;

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

    private static void Mutate(string carrierPath, string key, IFileSystem? fileSystem, Action<JsonArray> edit)
    {
        var system = fileSystem ?? Disk;
        var files = system.File;
        var document = ReadCarrier(files, carrierPath);
        var orders = document[OrderMember] as JsonObject;
        if (orders is null)
        {
            orders = new JsonObject();
            document[OrderMember] = orders;
        }

        // Detached first: a JsonNode already parented cannot be re-assigned into the same document.
        var list = orders[key] as JsonArray ?? new JsonArray();
        var working = new JsonArray();
        foreach (var entry in list) working.Add(entry!.GetValue<string>());

        edit(working);

        // An emptied list is dropped, not written as an empty array: the whole-mod door writes nothing for
        // a childless collection, and the compile gate compares byte-for-byte.
        if (working.Count > 0) orders[key] = working;
        else orders.Remove(key);
        if (orders.Count == 0) document.Remove(OrderMember);

        system.Directory.CreateDirectory(Path.GetDirectoryName(carrierPath)!);
        WriteCarrier(system, carrierPath, document);
    }

    /// <summary>Splices every folder-split collection's order into its parent's document, between the
    /// whole-mod door's write and the enumeration into committed files — the one place Track and
    /// Absorb share.</summary>
    internal static void SpliceInto(string treeRoot, IModGetter mod, IFileSystem? fileSystem = null)
    {
        var system = fileSystem ?? Disk;
        var files = system.File;

        // Carriers this walk does not yield lose their member: an emptied collection is otherwise
        // invisible, leaving a list that names a vanished child — a tree the read path refuses.
        var stale = system.Directory.Exists(treeRoot)
            ? system.Directory
                .EnumerateFiles(treeRoot, "*.json", SearchOption.AllDirectories)
                .Where(IsCarrierName)
                .ToHashSet(StringComparer.Ordinal)
            : [];

        foreach (var group in Enumerate(treeRoot, mod).GroupBy(c => c.CarrierPath, StringComparer.Ordinal))
        {
            stale.Remove(group.Key);
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

            document[OrderMember] = orders;
            system.Directory.CreateDirectory(Path.GetDirectoryName(group.Key)!);
            WriteCarrier(system, group.Key, document);
        }

        foreach (var carrier in stale)
        {
            var document = ReadCarrier(files, carrier);
            if (document.Remove(OrderMember)) WriteCarrier(system, carrier, document);
        }
    }

    private static bool IsCarrierName(string path)
    {
        var leaf = Path.GetFileName(path);
        return leaf.Equals(SourceUnitResolver.RecordDataFileName, StringComparison.Ordinal)
            || leaf.Equals(SourceUnitResolver.GroupRecordDataFileName, StringComparison.Ordinal);
    }

    /// <summary>Restores every folder-split collection to its parent's recorded order. Mandatory:
    /// identity-only file names leave the reader's enumeration order undefined.</summary>
    internal static void ApplyTo(string treeRoot, IMod mod, IFileSystem? fileSystem = null)
    {
        var files = (fileSystem ?? Disk).File;
        foreach (var collection in Enumerate(treeRoot, mod))
        {
            var document = ReadCarrier(files, collection.CarrierPath);
            var recorded = document[OrderMember]?[collection.Key] as JsonArray;

            var identities = collection.Identities;
            var wanted = recorded is null ? [] : recorded.Select(entry => entry!.GetValue<string>()).ToList();

            var byIdentity = new Dictionary<string, object>(StringComparer.Ordinal);
            for (var i = 0; i < identities.Count; i++) byIdentity[identities[i]] = collection.Children[i];

            // Present but unlisted: refuse. Appending would invent a position, a gameplay change for
            // DialogTopic.Responses (ADR-0042 decision 5); re-Track is the recovery.
            var unlisted = identities.Where(i => !wanted.Contains(i, StringComparer.Ordinal)).ToList();
            if (unlisted.Count > 0)
            {
                throw new SourceChildOrderDriftException(
                    $"'{Describe(collection)}' holds {unlisted.Count} folder-split " +
                    $"child(ren) that '{collection.CarrierPath}' does not name: {string.Join(", ", unlisted)}. " +
                    "Nothing can say where they belong in the order — re-Track the plugin to rebuild " +
                    "the tree from its binary.");
            }

            // Listed but absent: a deletion, not corruption. Deleting the file is how a record is deleted by
            // hand, and ADR-0041's working-tree model makes that a first-class edit.
            collection.Rewrite([.. wanted.Where(byIdentity.ContainsKey).Select(identity => byIdentity[identity])]);

        }
    }

    private static string Describe(OrderedCollection collection) =>
        $"{collection.Key} under {collection.CarrierPath}";

    // Walks the model, not the tree: the model knows the order on the way out, and the paths built here
    // do not depend on it.
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

        // A list group (Fallout 4's Cells, holding CellBlocks) is not an IGroupGetter, so the loop above
        // never sees it; its children are blocks.
        foreach (var property in ListGroupProperties(mod.GetType()))
        {
            if (property.GetValue(mod) is not IEnumerable group) continue;
            var folder = Path.Combine(treeRoot, property.Name);
            var (blocks, rewrite) = ListGroupSlot(group);
            if (blocks.Count == 0) continue;

            yield return new OrderedCollection(
                Path.Combine(folder, SourceUnitResolver.GroupRecordDataFileName), property.Name, blocks, rewrite);

            foreach (var block in blocks)
            {
                foreach (var nested in Walk(Path.Combine(folder, LeafOf(block)), block, parentIsRecord: false))
                    yield return nested;
            }
        }
    }

    // The element type is the group's generic argument, so ICollection<T> is reached reflectively.
    private static (IReadOnlyList<object> Children, Action<IReadOnlyList<object>> Rewrite) ListGroupSlot(IEnumerable group)
    {
        var children = group.Cast<object>().ToList();
        return (children, ordered =>
        {
            var element = group.GetType().GetInterfaces()
                .Single(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IListGroupGetter<>))
                .GetGenericArguments()[0];
            var collection = typeof(ICollection<>).MakeGenericType(element);
            collection.GetMethod(nameof(ICollection<object>.Clear))!.Invoke(group, null);
            var add = collection.GetMethod(nameof(ICollection<object>.Add))!;
            foreach (var child in ordered) add.Invoke(group, [child]);
        }
        );
    }

    // A member folder such as a Quest's DialogTopics exists only when parent and children are both major
    // records; where a block is on either side, children sit directly in the parent's directory. The
    // carrier follows the parent.
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

    // Embedded lists are excluded: Cell.{Temporary,Persistent,NavigationMeshes} are inlined by
    // CellEmbedCustomization, so treating one as folder-split would mint a directory the reader fails on.
    private static IEnumerable<PropertyInfo> FolderSplitProperties(Type type) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0
                        && !EmbeddedListMembers.Contains(p.Name)
                        && ElementOf(p.PropertyType) is { } element
                        && (typeof(IMajorRecordGetter).IsAssignableFrom(element) || IsBlock(element)))
            .OrderBy(p => p.Name, StringComparer.Ordinal);

    /// <summary>Mirrors <see cref="Serialization.CellEmbedCustomization"/>'s list members, by name alone
    /// because the names are unique to Cell.</summary>
    internal static readonly IReadOnlySet<string> EmbeddedListMembers =
        new HashSet<string>(StringComparer.Ordinal) { "Temporary", "Persistent", "NavigationMeshes" };

    // Spelled against Fallout 4's types, but every Mutagen game names these three identically, which is
    // what keeps the walk reflective.
    private const string InteriorBlockNumber = nameof(Mutagen.Bethesda.Fallout4.CellBlock.BlockNumber);
    private const string ExteriorBlockX = nameof(Mutagen.Bethesda.Fallout4.WorldspaceBlock.BlockNumberX);
    private const string ExteriorBlockY = nameof(Mutagen.Bethesda.Fallout4.WorldspaceBlock.BlockNumberY);

    private static bool IsBlock(Type element) =>
        element.GetProperty(InteriorBlockNumber) is not null || element.GetProperty(ExteriorBlockX) is not null;

    // Always a directory: only asked of a child the walk descends into.
    private static string LeafOf(object child) => child switch
    {
        IMajorRecordGetter record => SourceUnitResolver.LeafNameFor(record.FormKey, record.EditorID, isDirectory: true),
        _ => BlockCoordinatesOf(child),
    };

    // BlockNumber for the interior nesting, "X, Y" for the exterior — the whole-mod door's own naming.
    private static string BlockCoordinatesOf(object block)
    {
        var type = block.GetType();
        var x = type.GetProperty(ExteriorBlockX)?.GetValue(block);
        var y = type.GetProperty(ExteriorBlockY)?.GetValue(block);
        if (x is not null && y is not null) return $"{x}, {y}";

        var sub = type.GetProperty(InteriorBlockNumber)?.GetValue(block);
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

    private static IEnumerable<PropertyInfo> ListGroupProperties(Type type) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0 && typeof(IListGroupGetter).IsAssignableFrom(p.PropertyType))
            .OrderBy(p => p.Name, StringComparer.Ordinal);

    // Tests IEnumerable, not IList; groups have their own carrier and strings are enumerables of
    // chars.
    private static Type? ElementOf(Type type)
    {
        if (type == typeof(string) || !type.IsGenericType) return null;
        if (!typeof(IEnumerable).IsAssignableFrom(type)) return null;
        if (typeof(IGroupGetter).IsAssignableFrom(type)) return null;

        var arguments = type.GetGenericArguments();
        return arguments.Length == 1 ? arguments[0] : null;
    }

    // Temp file then atomic rename: a carrier is usually a record's own RecordData.json, so a torn write
    // loses the record's fields, not just order.
    private static void WriteCarrier(IFileSystem system, string path, JsonObject document)
    {
        var temporary = path + ".tmp";
        try
        {
            system.File.WriteAllText(temporary, document.ToJsonString(CarrierOptions));
            system.File.Move(temporary, path, overwrite: true);
        }
        catch
        {
            if (system.File.Exists(temporary)) system.File.Delete(temporary);
            throw;
        }
    }

    private static JsonObject ReadCarrier(IFile files, string path) =>
        files.Exists(path)
            ? JsonNode.Parse(files.ReadAllText(path)) as JsonObject ?? new JsonObject()
            : new JsonObject();
}

/// <summary>The tree holds a folder-split child its parent's list does not name (ADR-0042 decision 5).
/// An <see cref="InvalidOperationException"/> because it is thrown on the read path: ingest
/// degrades to the binary, compile refuses.</summary>
public sealed class SourceChildOrderDriftException : InvalidOperationException
{
    public SourceChildOrderDriftException() { }

    public SourceChildOrderDriftException(string message) : base(message) { }

    public SourceChildOrderDriftException(string message, Exception innerException)
        : base(message, innerException) { }
}
