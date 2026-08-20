using System.Globalization;
using System.Reflection;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>
/// Wires a flat set of deserialized ledger records into a freshly-created, otherwise-empty
/// <see cref="IMod"/>'s real containment structure (#416 S1b) — the inverse of the split
/// <see cref="Ledger.ContainerStripFields"/> makes at ingest and Track time. Nothing here is
/// game-specific: every structural fact (which cell holds which placed ref, which worldspace holds
/// which cell, which quest holds which dialog topic) comes from the index
/// (<see cref="IRecordReads.GetPlacement"/>/<see cref="IRecordReads.GetCellLocation"/>/
/// <see cref="IRecordReads.GetContainerChildren"/>), never from a hardcoded type name beyond the
/// handful <see cref="Ledger.ContainerStripFields"/> itself already names.
///
/// <para><b>Ref-invariant reads, deliberately</b> (Q1's #416 ruling): containment is carried
/// structure, not ledger content — no gesture in this arc lets a user move a record between
/// containers or reorder a container's children, so every read this class makes answers the same
/// regardless of which <see cref="RecordRef"/> the caller is positioned on. A future gesture that
/// *does* mutate containment must either make these reads ref-aware or move containment into ledger
/// text; ADR-0041's 2026-08-19 amendment already defers exactly that class of design question to the
/// moment compile actually needs it.</para>
///
/// <para><b>Completeness, not silence</b>: a ledger record this class cannot place anywhere — no
/// top-level group, and no containment index entry names a parent for it — is reported as
/// <see cref="AssembleResult.UnplaceableFormKeys"/> rather than dropped. <see cref="PluginCompileService"/>
/// turns a non-empty list into a typed structurally-cannot-emit refusal; nothing here writes a binary
/// that silently omits a record it couldn't find a home for.</para>
/// </summary>
internal static class ContainerAssembler
{
    internal sealed record AssembleResult(IReadOnlyList<string> UnplaceableFormKeys);

    // Keyed on the actual parent object instance (a WorldspaceBlock/WorldspaceSubBlock created
    // earlier in the same Assemble call) — comparing by reference, never by value, because these
    // objects are mutated in place as siblings are added and Loqui-generated equality is typically
    // structural: a value-equality dictionary key would silently collide once two blocks' contents
    // happened to match, or stop matching itself once a block gained its first child.
    private sealed class ReferenceKeyComparer : IEqualityComparer<(object Parent, string List, int X, int Y)>
    {
        public bool Equals((object Parent, string List, int X, int Y) a, (object Parent, string List, int X, int Y) b) =>
            ReferenceEquals(a.Parent, b.Parent) && a.List == b.List && a.X == b.X && a.Y == b.Y;
        public int GetHashCode((object Parent, string List, int X, int Y) k) =>
            HashCode.Combine(System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(k.Parent), k.List, k.X, k.Y);
    }

    // Same reference-identity reasoning as ReferenceKeyComparer, for the (parent, slot) pairs
    // ClearSlotOnce tracks.
    private sealed class ParentSlotComparer : IEqualityComparer<(object Parent, string Slot)>
    {
        public bool Equals((object Parent, string Slot) a, (object Parent, string Slot) b) =>
            ReferenceEquals(a.Parent, b.Parent) && a.Slot == b.Slot;
        public int GetHashCode((object Parent, string Slot) k) =>
            HashCode.Combine(System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(k.Parent), k.Slot);
    }

    internal static AssembleResult Assemble(
        IMod mod, IReadOnlyDictionary<string, IMajorRecord> recordsByFormKey, IRecordReads index, PluginKey plugin)
    {
        var placed = new HashSet<string>(StringComparer.Ordinal);
        var unplaceable = new List<string>();
        var gridChildren = new Dictionary<(object Parent, string List, int X, int Y), object>(new ReferenceKeyComparer());
        // #416 review: a slot this pass is about to populate is cleared exactly once, the first time
        // anything tries to attach to it — never assume a freshly-deserialized parent's slot is empty.
        // A repo tracked before a ContainerStripFields fix landed (Quest.Scenes, until this same
        // ticket) has committed baselines whose Quest ledger still inlines its old, unstripped
        // content while the same Scene also has its own separate ledger file; replacing beats
        // appending onto whatever the parent's ledger text happened to carry (never-assume-exclusive-
        // ownership, root CLAUDE.md — that applies to committed text this process didn't just write,
        // not only to files on disk).
        var clearedSlots = new HashSet<(object Parent, string Slot)>(new ParentSlotComparer());

        // Pass 1: every record that has a genuine top-level group (the ~95% non-container case, plus
        // Worldspace and Quest — top-level records that are *themselves* containers of stripped
        // children, handled in pass 2/4 below without needing to already sit in the tree).
        foreach (var (formKey, record) in recordsByFormKey)
        {
            if (TryPlaceTopLevel(mod, record)) placed.Add(formKey);
        }

        // Pass 2: cells — into their worldspace's block/sub-block tree (exterior) or the plugin's own
        // single interior bucket (interior; #416 S1c finding — no index preserves the *original*
        // CellBlock/CellSubBlock numbering Bethesda's own tools assigned interior cells, and nothing
        // in this arc lets a user move a cell between buckets, so one deterministic bucket per
        // compile is both correct — the game does not read interior BlockNumber — and stable under
        // repeated compiles of the same ledger, which is the property #416's round-trip gate needs).
        object? interiorSubBlock = null;
        foreach (var (formKey, record) in recordsByFormKey)
        {
            if (ContainerStripFields.NormalizedTypeName(record.GetType()) != "Cell") continue;

            var loc = index.GetCellLocation(plugin, formKey);
            if (loc == null) { unplaceable.Add(formKey); continue; }

            if (loc.Value.IsInterior)
            {
                interiorSubBlock ??= CreateInteriorCellBucket(mod, record);
                AddViaReflection(GetProperty(interiorSubBlock, "Cells"), record);
                placed.Add(formKey);
                continue;
            }

            if (loc.Value.ParentWorldspace is not { } worldspaceFormKey
                || !recordsByFormKey.TryGetValue(worldspaceFormKey, out var worldspace))
            {
                // The worldspace this cell belongs to isn't in this plugin's own ledger (a foreign
                // master's worldspace) — reconstructing the stub GRUP nesting an override needs in
                // that case is deliberately out of this ticket's scope (#416); refuse rather than
                // guess at a shape nothing here has verified.
                unplaceable.Add(formKey);
                continue;
            }

            AttachExteriorCell(worldspace, loc.Value, record, gridChildren);
            placed.Add(formKey);
        }

        // Pass 3: placed refs — into their cell's Persistent/Temporary list. Ordered by FormKey
        // (not original file order — placement carries no ordering column today; #416 measures
        // whether that matters against the real round-trip fixture and files it separately if so)
        // purely so the same ledger set always assembles in the same order.
        foreach (var formKey in recordsByFormKey.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            if (placed.Contains(formKey)) continue;
            var placement = index.GetPlacement(formKey, plugin);
            if (placement == null) continue;

            if (!recordsByFormKey.TryGetValue(placement.Value.ParentCell, out var cell))
            {
                unplaceable.Add(formKey);
                continue;
            }

            var slotName = placement.Value.PlacementGroup == "persistent" ? "Persistent" : "Temporary";
            ClearSlotOnce(cell, slotName, clearedSlots);
            AttachChild(cell, slotName, recordsByFormKey[formKey]);
            placed.Add(formKey);
        }

        // Pass 4: the five container_child relationships (#416 S1b) — Cell.NavigationMeshes/Landscape,
        // Quest.DialogBranches/DialogTopics, DialogTopic.Responses. Runs over every Cell/Quest/
        // DialogTopic regardless of whether *it* has been placed yet (attaching a child mutates the
        // parent object directly; it needs the parent object to exist, not to already be reachable
        // from the mod root) — which is what lets a DialogTopic's own Responses attach in the same
        // pass that attaches the DialogTopic to its Quest, in either order.
        foreach (var (formKey, record) in recordsByFormKey)
        {
            var parentType = ContainerStripFields.NormalizedTypeName(record.GetType());
            if (parentType is not ("Cell" or "Quest" or "DialogTopic")) continue;

            foreach (var child in index.GetContainerChildren(plugin, formKey))
            {
                if (!recordsByFormKey.TryGetValue(child.ChildFormKey, out var childRecord))
                {
                    unplaceable.Add(child.ChildFormKey);
                    continue;
                }
                ClearSlotOnce(record, child.SlotName, clearedSlots);
                AttachChild(record, child.SlotName, childRecord);
                placed.Add(child.ChildFormKey);
            }
        }

        var trulyUnplaced = recordsByFormKey.Keys.Where(fk => !placed.Contains(fk));
        var allUnplaceable = unplaceable.Concat(trulyUnplaced).Distinct(StringComparer.Ordinal).ToList();
        return new AssembleResult(allUnplaceable);
    }

    private static bool TryPlaceTopLevel(IMod mod, IMajorRecord record)
    {
        try
        {
            if (mod.TryGetTopLevelGroup(record.GetType()) is not { } group) return false;
            group.SetUntyped(record);
            return true;
        }
        catch (ArgumentException)
        {
            // IModGetter.TryGetTopLevelGroup's own documented "nested types" case: Cell and every
            // stripped-child type ContainerStripFields names are exactly the types that land here.
            // Not top-level — pass 2 through 4 place these instead.
            return false;
        }
    }

    // ── Exterior cell placement — WorldspaceBlock/WorldspaceSubBlock, grouped by the same
    //    coordinates PlacementWalker captured at ingest. Types are resolved by name from the
    //    worldspace object's own assembly/namespace (RecordTextCodec/ContainerStripFields' pattern,
    //    root CLAUDE.md's game-generalization rule), never a hardcoded game type.

    private static void AttachExteriorCell(
        IMajorRecord worldspace, CellLocationRow loc, IMajorRecord cell,
        Dictionary<(object Parent, string List, int X, int Y), object> gridChildren)
    {
        if (loc.BlockX is not { } blockX || loc.BlockY is not { } blockY)
        {
            // No block/sub coordinates is exactly how a worldspace's own TopCell was recorded
            // (PlacementWalker.EmitCell's `default` BlockCoords case) — never a sub-cell.
            SetProperty(worldspace, "TopCell", cell);
            return;
        }

        var block = GetOrCreateGridChild(worldspace, "SubCells", "BlockNumberX", "BlockNumberY", blockX, blockY, gridChildren);
        var subX = loc.SubX ?? 0;
        var subY = loc.SubY ?? 0;
        var subBlock = GetOrCreateGridChild(block, "Items", "BlockNumberX", "BlockNumberY", subX, subY, gridChildren);
        AddViaReflection(GetProperty(subBlock, "Items"), cell);
    }

    // The plugin's own single interior bucket (see the S1c note on Assemble's pass 2). The
    // CellBlock/CellSubBlock type names are resolved the same namespace-driven way as the exterior
    // ones. mod.Cells is reached by plain property-name reflection, PlacementWalker's own read-side
    // pattern, rather than TryGetTopLevelGroup — that mechanism is for Group-of-major-records, and a
    // CellBlock carries no FormKey, so it was never part of it.
    private static object CreateInteriorCellBucket(IMod mod, IMajorRecord anyCell)
    {
        var ns = anyCell.GetType().Namespace!;
        var assembly = anyCell.GetType().Assembly;
        var block = Activator.CreateInstance(assembly.GetType($"{ns}.CellBlock")!)!;
        var subBlock = Activator.CreateInstance(assembly.GetType($"{ns}.CellSubBlock")!)!;
        SetProperty(block, "BlockNumber", 0);
        SetProperty(subBlock, "BlockNumber", 0);
        AddViaReflection(GetProperty(block, "SubBlocks"), subBlock);

        var cellsGroup = GetProperty(mod, "Cells");
        AddViaReflection(GetProperty(cellsGroup, "Records"), block);

        return subBlock;
    }

    private static object GetOrCreateGridChild(
        object parent, string listPropertyName, string xPropertyName, string yPropertyName, int x, int y,
        Dictionary<(object Parent, string List, int X, int Y), object> gridChildren)
    {
        var key = (parent, listPropertyName, x, y);
        if (gridChildren.TryGetValue(key, out var existing)) return existing;

        var listProperty = GetProperty(parent, listPropertyName);
        var itemType = ItemTypeOf(listProperty);
        var child = Activator.CreateInstance(itemType)!;
        SetProperty(child, xPropertyName, Convert.ChangeType(x, PropertyType(child, xPropertyName), CultureInfo.InvariantCulture));
        SetProperty(child, yPropertyName, Convert.ChangeType(y, PropertyType(child, yPropertyName), CultureInfo.InvariantCulture));
        AddViaReflection(listProperty, child);

        gridChildren[key] = child;
        return child;
    }

    // ── generic reflection plumbing ──────────────────────────────────────────────

    /// <summary>
    /// Clears <paramref name="parent"/>'s named slot the first time anything is about to attach to
    /// it this <see cref="Assemble"/> call — a no-op every subsequent time (tracked in
    /// <paramref name="clearedSlots"/>), so a slot with N children is cleared once and then filled,
    /// never cleared between siblings. Same dual-mode shape as
    /// <see cref="Ledger.ContainerStripFields.StripInPlace"/> (<c>Clear()</c> for a list, null for a
    /// single reference) — deliberately, since this is that method's own inverse: replacing whatever
    /// a freshly-deserialized parent's ledger text happened to carry in this slot, never trusting it
    /// to already be empty.
    /// </summary>
    private static void ClearSlotOnce(object parent, string slotName, HashSet<(object Parent, string Slot)> clearedSlots)
    {
        if (!clearedSlots.Add((parent, slotName))) return;

        var property = parent.GetType().GetProperty(slotName)
            ?? throw new InvalidOperationException($"{parent.GetType().Name} has no property '{slotName}'.");
        var current = property.GetValue(parent);
        var clear = current?.GetType().GetMethod("Clear", Type.EmptyTypes);
        if (clear != null)
            clear.Invoke(current, null);
        else
            property.SetValue(parent, null);
    }

    /// <summary>Attaches <paramref name="child"/> to <paramref name="parent"/>'s named slot — a list
    /// property (<c>Add</c>) or a still-null single-reference property (direct assignment), matching
    /// <see cref="Ledger.ContainerStripFields.StripInPlace"/>'s own dual-mode shape inverted.</summary>
    private static void AttachChild(object parent, string slotName, IMajorRecord child)
    {
        var property = parent.GetType().GetProperty(slotName)
            ?? throw new InvalidOperationException($"{parent.GetType().Name} has no property '{slotName}'.");
        var current = property.GetValue(parent);
        if (current == null)
        {
            property.SetValue(parent, child);
            return;
        }
        AddViaReflection(current, child);
    }

    private static void AddViaReflection(object list, object item)
    {
        var add = list.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(m => m.Name == "Add" && m.GetParameters() is [var p] && p.ParameterType.IsInstanceOfType(item));
        if (add == null)
            throw new InvalidOperationException($"{list.GetType().Name} has no Add(...) accepting a {item.GetType().Name}.");
        add.Invoke(list, [item]);
    }

    private static object GetProperty(object owner, string name) =>
        (owner.GetType().GetProperty(name) ?? throw new InvalidOperationException($"{owner.GetType().Name} has no property '{name}'."))
            .GetValue(owner)
        ?? throw new InvalidOperationException($"{owner.GetType().Name}.{name} is null.");

    private static void SetProperty(object owner, string name, object? value) =>
        (owner.GetType().GetProperty(name) ?? throw new InvalidOperationException($"{owner.GetType().Name} has no property '{name}'."))
            .SetValue(owner, value);

    private static Type PropertyType(object owner, string name) =>
        (owner.GetType().GetProperty(name) ?? throw new InvalidOperationException($"{owner.GetType().Name} has no property '{name}'."))
            .PropertyType;

    // The list property's element type — ExtendedList<T> and kin all expose it as their sole
    // interface generic argument's target.
    private static Type ItemTypeOf(object list)
    {
        var listType = list.GetType();
        var enumerable = listType.GetInterfaces()
            .FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>));
        return enumerable?.GetGenericArguments()[0]
            ?? throw new InvalidOperationException($"{listType.Name} isn't a generic collection.");
    }
}
