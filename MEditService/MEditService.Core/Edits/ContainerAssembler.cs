using System.Globalization;
using System.Reflection;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>
/// Wires a flat set of deserialized source records into a freshly-created, otherwise-empty
/// <see cref="IMod"/>'s real containment structure (#416 S1b) — the inverse of the split
/// <see cref="Source.ContainerChildFields"/> makes at ingest and Track time. Nothing here is
/// game-specific: every structural fact (which cell holds which placed ref, which worldspace holds
/// which cell, which quest holds which dialog topic) comes from the index
/// (<see cref="IRecordReads.GetPlacement"/>/<see cref="IRecordReads.GetCellLocation"/>/
/// <see cref="IRecordReads.GetContainerChildren"/>), never from a hardcoded type name beyond the
/// handful <see cref="Source.ContainerChildFields"/> itself already names.
///
/// <para><b>Ref-invariant reads, deliberately</b> (Q1's #416 ruling): containment is carried
/// structure, not source content — no gesture in this arc lets a user move a record between
/// containers or reorder a container's children, so every read this class makes answers the same
/// regardless of which <see cref="RecordRef"/> the caller is positioned on. A future gesture that
/// *does* mutate containment must either make these reads ref-aware or move containment into source
/// text; ADR-0041's 2026-08-19 amendment already defers exactly that class of design question to the
/// moment compile actually needs it.</para>
///
/// <para><b>Completeness, not silence</b>: a source record this class cannot place anywhere — no
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
    // AttachBufferedChildren groups by.
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
        // Child attachments are buffered rather than applied as they are found, and flushed per
        // (parent, slot) by AttachBufferedChildren below. Two reasons, both #450's:
        //
        //   Clearing. A container's source text now carries its embedded children (Spriggit's embed
        //     customization), so a freshly-deserialized parent arrives here with its slots already
        //     populated — appending would double every child, the parent's own inline copy plus the
        //     one attached from the child's own source file. Buffering makes "clear once, then fill"
        //     structural rather than something a HashSet has to remember (#416 review's original
        //     point, which also covered committed baselines carrying pre-fix inlined content).
        //   Ordering. Compile writes the binary from what this produces, so a slot rebuilt in the
        //     wrong order is a silent content change in the user's plugin. There are two ordering
        //     sources because there are two kinds of slot, and each is the only one available for
        //     its own kind — see AttachBufferedChildren. Buffering is what lets a slot be ordered as
        //     a whole rather than one child at a time in discovery order.
        var pendingChildren = new List<(object Parent, string Slot, IMajorRecord Child, int? SlotIndex)>();

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
        // repeated compiles of the same source, which is the property #416's round-trip gate needs).
        object? interiorSubBlock = null;
        foreach (var (formKey, record) in recordsByFormKey)
        {
            if (ContainerChildFields.NormalizedTypeName(record.GetType()) != "Cell") continue;

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
                // The worldspace this cell belongs to isn't in this plugin's own source (a foreign
                // master's worldspace) — reconstructing the stub GRUP nesting an override needs in
                // that case is deliberately out of this ticket's scope (#416); refuse rather than
                // guess at a shape nothing here has verified.
                unplaceable.Add(formKey);
                continue;
            }

            AttachExteriorCell(worldspace, loc.Value, record, gridChildren);
            placed.Add(formKey);
        }

        // Pass 3: placed refs — into their cell's Persistent/Temporary list. `placement` carries no
        // ordering column, so these are buffered with no slot index and take their order from the
        // parent cell's own document, which since #450 embeds them (AttachBufferedChildren). The
        // FormKey iteration order here only makes the buffer's own contents deterministic; it is not
        // the order anything is attached in.
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
            pendingChildren.Add((cell, slotName, recordsByFormKey[formKey], null));
            placed.Add(formKey);
        }

        // Pass 4: the container_child relationships (#416 S1b) — Cell.NavigationMeshes/Landscape,
        // Quest.DialogBranches/DialogTopics/Scenes, DialogTopic.Responses. Runs over every Cell/Quest/
        // DialogTopic regardless of whether *it* has been placed yet (attaching a child mutates the
        // parent object directly; it needs the parent object to exist, not to already be reachable
        // from the mod root) — which is what lets a DialogTopic's own Responses attach in the same
        // pass that attaches the DialogTopic to its Quest, in either order.
        //
        // SlotIndex rides along into the buffer and is the ordering source for these. It is the only
        // one they have: the slots Spriggit does not embed are written folder-split and read back
        // empty, so the parent record handed to this pass carries no order to recover.
        foreach (var (formKey, record) in recordsByFormKey)
        {
            var parentType = ContainerChildFields.NormalizedTypeName(record.GetType());
            if (parentType is not ("Cell" or "Quest" or "DialogTopic")) continue;

            foreach (var child in index.GetContainerChildren(plugin, formKey))
            {
                if (!recordsByFormKey.TryGetValue(child.ChildFormKey, out var childRecord))
                {
                    unplaceable.Add(child.ChildFormKey);
                    continue;
                }
                pendingChildren.Add((record, child.SlotName, childRecord, child.SlotIndex));
                placed.Add(child.ChildFormKey);
            }
        }

        AttachBufferedChildren(pendingChildren);

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
            // stripped-child type ContainerChildFields names are exactly the types that land here.
            // Not top-level — pass 2 through 4 place these instead.
            return false;
        }
    }

    // ── Exterior cell placement — WorldspaceBlock/WorldspaceSubBlock, grouped by the same
    //    coordinates PlacementWalker captured at ingest. Types are resolved by name from the
    //    worldspace object's own assembly/namespace (RecordTextCodec/ContainerChildFields' pattern,
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
    /// Applies every buffered attachment, one (parent, slot) at a time: work out the order that slot
    /// is supposed to end up in, clear it, then re-fill it in that order.
    ///
    /// <para><b>Two ordering sources, one per kind of slot, because neither covers both.</b></para>
    /// <list type="bullet">
    /// <item><b><c>container_child</c> slots</b> — the ones Spriggit does not embed
    /// (<c>Quest.DialogBranches</c>/<c>DialogTopics</c>/<c>Scenes</c>,
    /// <c>DialogTopic.Responses</c>, plus <c>Cell.NavigationMeshes</c>/<c>Landscape</c>) — order by
    /// the <c>SlotIndex</c> captured at ingest. Those children are written folder-split and read back
    /// empty (the codec's child-stream suppressions), so the parent record this is handed carries no
    /// order of its own to recover; <c>SlotIndex</c> is the only record of it that exists.</item>
    /// <item><b>Embedded slots</b> — <c>Cell.Persistent</c>/<c>Temporary</c>, attached from
    /// <c>placement</c>, which has no ordering column — order by the child's position in the
    /// <i>parent document's own</i> list, read off the slot before it is cleared. Since #450 the
    /// parent embeds them, so that position is right there in the record.</item>
    /// </list>
    ///
    /// <para>No slot draws on both: a relationship <c>placement</c> covers is excluded from
    /// <c>container_child</c> by construction (<c>DuckDbRecordIndex.CoveredByPlacementTables</c>).
    /// The two are combined into one key anyway, rather than branched on, so a future relationship
    /// that did carry both would order sensibly instead of picking a winner by accident. A child with
    /// neither — added since ingest, or reaching a slot its parent does not inline — sorts last by
    /// FormKey, keeping the result deterministic
    /// (<c>CompileRoundTripGateTests.Compile_OfTheRealFixture_IsDeterministic</c>) even where it
    /// cannot be faithful.</para>
    ///
    /// <para>Getting this wrong is silent: the compiled plugin still holds every child, just in a
    /// different order, and it reaches the user's source text through the next ingest.
    /// <c>ContainerAssemblerOrderingTests</c> covers the <c>container_child</c> half; the #369
    /// real-fixture compile gate covers the embedded half (it caught cell <c>018AA2</c>).</para>
    ///
    /// <para><b>#452 changed what <c>SlotIndex</c> means, and the change is deliberate — read this
    /// before treating a reordering as a bug.</b> This ordering fix was justified against a
    /// <i>binary</i>-seeded ingest, where <c>SlotIndex</c> was the binary's own GRUP order. A tracked
    /// plugin now ingests from its source tree, so <c>SlotIndex</c> is whatever the deserializer
    /// produced — and <b>Spriggit's layout carries no child ordering at all</b>: its reader sorts by a
    /// <c>"[N] "</c> file-name prefix that is written only under <c>Overall.EnforceRecordOrder</c>,
    /// which neither this project nor Spriggit enables, so a stable sort on an all-null key leaves
    /// filesystem order (traced in <c>references/mutagen-serialization</c>; measured at 233 parents on
    /// the real fixture by <c>SourceIngestParityTests</c>, which pins it as a named allowlist entry).</para>
    ///
    /// <para>So for a tracked plugin, compile reproduces the <i>tree's</i> child order, not the
    /// original binary's. That is consistent with the arc's model rather than a regression against it:
    /// source is the truth, order stays <b>stable</b> (same tree, same order) without being
    /// <b>canonical</b> against the pre-Track binary — which is exactly what #454's scope item 4 says
    /// a compiled-from-text binary does, and what <c>CompileRoundTripGateTests</c>' own doc comment
    /// already concedes ("no canonical 'correct' value to reproduce, only a stable one"). Enabling
    /// <c>EnforceRecordOrder</c> would restore canonical order and was rejected: it puts <c>"[N] "</c>
    /// into on-disk file names, abandoning the layout ADR-0041 pins wholesale and the Spriggit
    /// byte-parity convergence target #455 gates.</para>
    /// </summary>
    private static void AttachBufferedChildren(
        List<(object Parent, string Slot, IMajorRecord Child, int? SlotIndex)> pending)
    {
        foreach (var group in pending.GroupBy(p => (p.Parent, p.Slot), new ParentSlotComparer()))
        {
            var (parent, slotName) = group.Key;
            var documentOrder = SlotChildFormKeys(parent, slotName);
            ClearSlot(parent, slotName);

            foreach (var item in group
                         .OrderBy(i => i.SlotIndex ?? DocumentPosition(documentOrder, i.Child))
                         .ThenBy(i => i.Child.FormKey.ToString(), StringComparer.Ordinal))
            {
                AttachChild(parent, slotName, item.Child);
            }
        }
    }

    /// <summary>The FormKeys currently in <paramref name="parent"/>'s named slot, in order — the
    /// embedded children its own source text carried. Empty for a slot the document did not
    /// inline.</summary>
    private static List<string> SlotChildFormKeys(object parent, string slotName) =>
        RequireProperty(parent, slotName).GetValue(parent) switch
        {
            IMajorRecordGetter single => [single.FormKey.ToString()],
            System.Collections.IEnumerable list and not string =>
                [.. list.OfType<IMajorRecordGetter>().Select(r => r.FormKey.ToString())],
            _ => [],
        };

    private static int DocumentPosition(List<string> documentOrder, IMajorRecord child) =>
        documentOrder.IndexOf(child.FormKey.ToString()) is var i && i >= 0 ? i : int.MaxValue;

    /// <summary>Empties <paramref name="parent"/>'s named slot. Dual-mode (<c>Clear()</c> for a list,
    /// null for a single reference) because the slots are.</summary>
    private static void ClearSlot(object parent, string slotName)
    {
        var property = RequireProperty(parent, slotName);
        var current = property.GetValue(parent);
        var clear = current?.GetType().GetMethod("Clear", Type.EmptyTypes);
        if (clear != null)
            clear.Invoke(current, null);
        else
            property.SetValue(parent, null);
    }

    /// <summary>Attaches <paramref name="child"/> to <paramref name="parent"/>'s named slot — a list
    /// property (<c>Add</c>) or a still-null single-reference property (direct assignment) — the
    /// same dual-mode shape <see cref="ClearSlot"/> handles, on the filling side.</summary>
    private static void AttachChild(object parent, string slotName, IMajorRecord child)
    {
        var property = RequireProperty(parent, slotName);
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
        RequireProperty(owner, name).GetValue(owner)
        ?? throw new InvalidOperationException($"{owner.GetType().Name}.{name} is null.");

    private static void SetProperty(object owner, string name, object? value) =>
        RequireProperty(owner, name).SetValue(owner, value);

    private static Type PropertyType(object owner, string name) =>
        RequireProperty(owner, name).PropertyType;

    // #416 review: the single place "does this reflected object have the property this call site
    // needs" is asked and answered — every other member here that used to repeat its own
    // GetProperty(name) ?? throw goes through this instead, so a stale ContainerChildFields entry
    // (or a game module missing a property the walker assumes) fails with the same named, actionable
    // message no matter which of the five call sites hit it first.
    private static PropertyInfo RequireProperty(object owner, string name) =>
        owner.GetType().GetProperty(name)
        ?? throw new InvalidOperationException($"{owner.GetType().Name} has no property '{name}'.");

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
