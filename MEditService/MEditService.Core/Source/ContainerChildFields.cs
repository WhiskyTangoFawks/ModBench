using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>Which fields of a container hold child major records — the index's <c>container_child</c>
/// rows. Nothing is stripped (ADR-0041 amendment). Hand-maintained; a gap here costs an index
/// row, never a record in the compiled binary.</summary>
internal static class ContainerChildFields
{
    private static readonly Dictionary<string, string[]> ByTypeName = new(StringComparer.Ordinal)
    {
        ["Cell"] = ["Persistent", "Temporary", "NavigationMeshes", "Landscape"],
        ["Worldspace"] = ["TopCell", "SubCells"],
        // Scenes: Scene is a major record with no top-level group of its own.
        ["Quest"] = ["DialogBranches", "DialogTopics", "Scenes"],
        ["DialogTopic"] = ["Responses"],
    };

    /// <summary>The child-major field names for <paramref name="recordType"/>, or null when it is not a
    /// known container shape.</summary>
    internal static IReadOnlyList<string>? EnumerateChildFieldsFor(Type recordType) =>
        ByTypeName.TryGetValue(NormalizedTypeName(recordType), out var fields) ? fields : null;

    private const string OverlaySuffix = "BinaryOverlay";

    private const string GetterPrefix = "I";
    private const string GetterSuffix = "Getter";

    /// <summary>A binary overlay's runtime type is "NameBinaryOverlay" and a schema's record type
    /// its "INameGetter" interface; normalized once so ingest, Track and a document read key off the
    /// same name.</summary>
    internal static string NormalizedTypeName(Type recordType)
    {
        var name = recordType.Name;
        if (name.EndsWith(OverlaySuffix, StringComparison.Ordinal)) return name[..^OverlaySuffix.Length];
        return recordType.IsInterface && name.StartsWith(GetterPrefix, StringComparison.Ordinal) && name.EndsWith(GetterSuffix, StringComparison.Ordinal)
            ? name[GetterPrefix.Length..^GetterSuffix.Length]
            : name;
    }

    /// <summary><see cref="Child"/> is the real object hanging off Parent, not a copy: mutating it and
    /// reserializing the document's root is how an embedded child is written. Parent is the direct
    /// container, which a slot replace needs.</summary>
    internal readonly record struct EmbeddedChild(IMajorRecordGetter Parent, string SlotName, int SlotIndex, IMajorRecord Child);

    /// <summary>The child through Mutagen's own object model, not a JSON pointer, so existing writers
    /// apply unchanged. Descends through <see cref="EmbeddedSlots"/> at every level.</summary>
    internal static EmbeddedChild? FindEmbeddedChild(IMajorRecordGetter parent, string formKey) =>
        FindEmbeddedChildSlot(parent, formKey) is { } slot
            ? new EmbeddedChild(slot.Parent, slot.SlotName, slot.SlotIndex, slot.Child)
            : null;

    /// <summary>Removes the child from wherever <see cref="FindEmbeddedChild"/> would find it: a list slot
    /// is spliced by index, a single-value slot set to null. False when nothing matched, never a throw.</summary>
    internal static bool RemoveEmbeddedChild(IMajorRecordGetter parent, string formKey)
    {
        if (FindEmbeddedChildSlot(parent, formKey) is not { } slot) return false;

        RemoveFromSlot(slot.Parent, slot.SlotName, slot.SlotIndex);
        return true;
    }

    // Carries the direct parent (a nested TopCell, not the top-level record) so a remove mutates the
    // right object.
    private readonly record struct EmbeddedChildSlot(IMajorRecordGetter Parent, string SlotName, int SlotIndex, IMajorRecord Child);

    // Descends through embedded slots at every level: a worldspace embeds its TopCell, which embeds its
    // placed references; a quest embeds its topics, which embed their responses. Bounded to
    // EmbeddedSlots: a worldspace's blocks have directories.
    private static EmbeddedChildSlot? FindEmbeddedChildSlot(IMajorRecordGetter parent, string formKey)
    {
        var parentType = NormalizedTypeName(parent.GetType());

        foreach (var (slotName, slotIndex, child) in EnumerateChildren(parent))
        {
            if (child.FormKey.ToString().Equals(formKey, StringComparison.Ordinal))
            {
                // Guarded rather than cast so a read-only graph (a binary overlay) declines instead of throwing.
                return child is IMajorRecord settable ? new EmbeddedChildSlot(parent, slotName, slotIndex, settable) : null;
            }

            if (!EmbeddedSlots.Contains((parentType, slotName))) continue;
            if (FindEmbeddedChildSlot(child, formKey) is { } deeper) return deeper;
        }

        return null;
    }

    /// <summary>The own-fields-only half of Copy as Override: xEdit's lands own-fields-only, containers
    /// included. Built over <see cref="EnumerateChildren"/>, so a record with no child slot is a
    /// no-op.</summary>
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

    /// <summary>Only ever a list slot (Persistent/Temporary): a single-value slot has no "append" to
    /// make sense of.</summary>
    internal static void AddChildToSlot(IMajorRecordGetter parent, string slotName, IMajorRecord child)
    {
        var property = parent.GetType().GetProperty(slotName)
            ?? throw new InvalidOperationException(
                $"{parent.GetType().Name} has no property '{slotName}' to add a child to — ContainerChildFields' table is stale.");

        ((dynamic)property.GetValue(parent)!).Add((dynamic)child);
    }

    /// <summary>The own-fields-replace half: the replacing record arrives child-stripped, and
    /// the destination's embedded children are re-attached so an own-fields copy can never silently
    /// delete them.</summary>
    internal static void TransplantChildSlots(IMajorRecordGetter from, IMajorRecordGetter to)
    {
        foreach (var (slotName, _, child) in EnumerateChildren(from).ToList())
        {
            var property = to.GetType().GetProperty(slotName)
                ?? throw new InvalidOperationException(
                    $"{to.GetType().Name} has no property '{slotName}' to transplant a child into — ContainerChildFields' table is stale.");
            // Branch on the slot's shape, not the current value — a cleared list slot could in
            // principle be null, and SetValue'ing a single child into a list property would crash.
            var value = property.GetValue(to);
            if (value is System.Collections.IEnumerable and not string) ((dynamic)value).Add((dynamic)child);
            else property.SetValue(to, child);
        }
    }

    /// <summary>In-place swap: the child must keep its exact position — an append-after-remove
    /// would silently reorder the cell's GRUP.</summary>
    internal static void ReplaceInSlot(IMajorRecordGetter parent, string slotName, int slotIndex, IMajorRecord child)
    {
        var property = parent.GetType().GetProperty(slotName)
            ?? throw new InvalidOperationException(
                $"{parent.GetType().Name} has no property '{slotName}' to replace a child in — ContainerChildFields' table is stale.");

        var value = property.GetValue(parent);
        if (value is IMajorRecordGetter) property.SetValue(parent, child);
        else ((dynamic)value!)[slotIndex] = (dynamic)child;
    }

    // Reflection plus dynamic so one path cannot drift from the table; RemoveAt resolves against the
    // slot's runtime list type.
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

    // The slots that serialize inline into the parent's document — the runtime shadow of the
    // embed customizations in Serialization/EmbedCustomizations.cs. Every slot of ByTypeName but a
    // worldspace's SubCells, whose blocks are directories. Keep in step with the customizations.
    internal static readonly HashSet<(string ParentType, string Slot)> EmbeddedSlots =
    [
        ("Cell", "Persistent"), ("Cell", "Temporary"), ("Cell", "Landscape"), ("Cell", "NavigationMeshes"),
        ("Worldspace", "TopCell"),
        ("Quest", "DialogTopics"), ("Quest", "DialogBranches"), ("Quest", "Scenes"),
        ("DialogTopic", "Responses"),
    ];

    /// <summary>Child major records read non-destructively off a getter, so ingest captures parentage in
    /// the same pass that writes the parent. <c>SlotIndex</c> is preserved so compile reproduces the
    /// original list order.</summary>
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
