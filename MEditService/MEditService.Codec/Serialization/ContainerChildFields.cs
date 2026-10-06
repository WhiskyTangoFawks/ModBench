using System.Collections.Concurrent;
using System.Reflection;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>Reading and writing a container's child major records through the members
/// <see cref="ContainerMembers"/> derives. Nothing is stripped.</summary>
public static class ContainerChildFields
{
    /// <summary>The child-major field names for <paramref name="recordType"/>, or null when it is not a
    /// known container shape, or its assembly is outside every game this build references.</summary>
    public static IReadOnlyList<string>? EnumerateChildFieldsFor(Type recordType) =>
        ContainerMembers.CategoryOf(recordType.Assembly) is { } category
        && ContainerMembers.Derived.ChildFieldsByType.TryGetValue((category, NormalizedTypeName(recordType)), out var fields)
            ? fields
            : null;

    private static readonly ConcurrentDictionary<GameCategory, IReadOnlySet<(string ParentType, string Slot)>> EmbeddedSlotsByCategory = new();

    private static readonly IReadOnlySet<(string ParentType, string Slot)> EmptyEmbeddedSlots = new HashSet<(string, string)>();

    /// <summary>One game's embedded slots, (ParentType, Slot) pairs with the game itself dropped —
    /// two games can share both a type name and a slot name.</summary>
    public static IReadOnlySet<(string ParentType, string Slot)> EmbeddedSlotsFor(GameCategory category) =>
        EmbeddedSlotsByCategory.GetOrAdd(category, c => ContainerMembers.Derived.EmbeddedSlots
            .Where(slot => slot.Game == c)
            .Select(slot => (slot.ParentType, slot.Slot))
            .ToHashSet());

    /// <summary>As <see cref="EmbeddedSlotsFor(GameCategory)"/>, from a type's own assembly. Empty
    /// for an assembly outside every game this build references.</summary>
    public static IReadOnlySet<(string ParentType, string Slot)> EmbeddedSlotsFor(Type anyTypeInTheGame) =>
        ContainerMembers.CategoryOf(anyTypeInTheGame.Assembly) is { } category ? EmbeddedSlotsFor(category) : EmptyEmbeddedSlots;

    /// <summary>Whether a record of <paramref name="recordType"/> has child slots at all: the copy
    /// gestures land one own-fields-only, and replace an existing override in place rather than
    /// refusing.</summary>
    public static bool HasChildFields(string recordType, GameRelease release) =>
        RecordTypeDispatch.For(release).ConcreteFor(recordType) is { } concrete
        && EnumerateChildFieldsFor(concrete) != null;

    private const string OverlaySuffix = "BinaryOverlay";

    private const string GetterPrefix = "I";
    private const string GetterSuffix = "Getter";

    /// <summary>A binary overlay's runtime type is "NameBinaryOverlay" and a schema's record type
    /// its "INameGetter" interface; normalized once so ingest, Track and a document read key off the
    /// same name.</summary>
    public static string NormalizedTypeName(Type recordType)
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
    /// apply unchanged. Descends only through <see cref="EmbeddedSlotsFor(Type)"/>: a worldspace's
    /// blocks have directories.</summary>
    internal static EmbeddedChild? FindEmbeddedChild(IMajorRecordGetter parent, string formKey)
    {
        var parentType = NormalizedTypeName(parent.GetType());
        var embeddedSlots = EmbeddedSlotsFor(parent.GetType());

        foreach (var (slotName, slotIndex, child) in EnumerateChildren(parent))
        {
            if (child.FormKey.ToString().Equals(formKey, StringComparison.Ordinal))
            {
                // Guarded rather than cast so a read-only graph (a binary overlay) declines instead of throwing.
                return child is IMajorRecord settable ? new EmbeddedChild(parent, slotName, slotIndex, settable) : null;
            }

            if (!embeddedSlots.Contains((parentType, slotName))) continue;
            if (FindEmbeddedChild(child, formKey) is { } deeper) return deeper;
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
            var property = SlotProperty(record.GetType(), slotName, "clear");

            var value = property.GetValue(record)
                ?? throw new InvalidOperationException(
                    $"Expected {record.GetType().Name}.{slotName} to hold a value or a collection to clear.");
            if (value is IMajorRecordGetter) property.SetValue(record, null);
            else ((dynamic)value).Clear();
        }
    }

    /// <summary>A list slot takes the child at its end; a single-value slot (a worldspace's persistent
    /// cell) takes it as its value.</summary>
    internal static void AddChildToSlot(IMajorRecordGetter parent, string slotName, IMajorRecord child)
    {
        var property = SlotProperty(parent.GetType(), slotName, "add a child to");

        if (typeof(System.Collections.IEnumerable).IsAssignableFrom(property.PropertyType))
        {
            var list = property.GetValue(parent)
                ?? throw new InvalidOperationException($"Expected {parent.GetType().Name}.{slotName} to hold a collection to add a child to.");
            ((dynamic)list).Add((dynamic)child);
            return;
        }

        if (property.GetValue(parent) is IMajorRecordGetter held)
            throw new ChildSlotHeldByAnotherRecordException(parent.GetType().Name, slotName, held.FormKey.ToString(), child.FormKey.ToString());
        property.SetValue(parent, child);
    }

    /// <summary>Each incoming child overwrites the one <paramref name="root"/> holds under its FormKey
    /// anywhere in its subtree or in <paramref name="carried"/>, landing in <paramref name="target"/>'s
    /// slot; with none held it is added. What only the held one holds stays.</summary>
    internal static void MergeChildren(
        IMajorRecordGetter root, IMajorRecordGetter target, IReadOnlyList<(string SlotName, IMajorRecordGetter Child)> incoming,
        IReadOnlyDictionary<FormKey, IMajorRecordGetter> carried)
    {
        foreach (var (slotName, source) in incoming)
        {
            var child = (IMajorRecord)source;
            var childrenToMerge = EnumerateChildren(child).Select(c => (c.SlotName, c.Child)).ToList();
            ClearAllChildSlots(child);

            if (FindEmbeddedChild(root, child.FormKey.ToString()) is not { } held)
            {
                if (carried.TryGetValue(child.FormKey, out var carriedHeld)) TransplantChildSlots(carriedHeld, child);
                AddChildToSlot(target, slotName, child);
            }
            else
            {
                TransplantChildSlots(held.Child, child);
                if (ReferenceEquals(held.Parent, target) && held.SlotName == slotName) ReplaceInSlot(held, child);
                else
                {
                    RemoveFromSlot(held);
                    AddChildToSlot(target, slotName, child);
                }
            }
            MergeChildren(root, child, childrenToMerge, carried);
        }
    }

    /// <summary>The incoming record's own fields over the held record's children, the incoming
    /// children merged in.</summary>
    internal static IMajorRecord Overwritten(IMajorRecordGetter held, IMajorRecordGetter incoming)
    {
        var incomingChildren = EnumerateChildren(incoming).Select(c => (c.SlotName, c.Child)).ToList();
        ClearAllChildSlots(incoming);
        TransplantChildSlots(held, incoming);
        MergeChildren(incoming, incoming, incomingChildren, new Dictionary<FormKey, IMajorRecordGetter>());
        return (IMajorRecord)incoming;
    }

    private static void ReplaceInSlot(EmbeddedChild held, IMajorRecord replacement)
    {
        var property = SlotProperty(held.Parent.GetType(), held.SlotName, "replace a child in");
        if (property.GetValue(held.Parent) is System.Collections.IEnumerable and not string and var list)
            ((dynamic)list)[held.SlotIndex] = (dynamic)replacement;
        else property.SetValue(held.Parent, replacement);
    }

    private static void RemoveFromSlot(EmbeddedChild held)
    {
        var property = SlotProperty(held.Parent.GetType(), held.SlotName, "remove a child from");
        if (property.GetValue(held.Parent) is System.Collections.IEnumerable and not string and var list)
            ((dynamic)list).RemoveAt(held.SlotIndex);
        else property.SetValue(held.Parent, null);
    }

    private static PropertyInfo SlotProperty(Type recordType, string slotName, string purpose) =>
        recordType.GetProperty(slotName)
        ?? throw new InvalidOperationException(
            $"{recordType.Name} has no property '{slotName}' to {purpose} — its child members are the assembly's own.");

    /// <summary>The own-fields-replace half: the replacing record arrives child-stripped, and
    /// the destination's embedded children are re-attached so an own-fields copy can never silently
    /// delete them.</summary>
    internal static void TransplantChildSlots(IMajorRecordGetter from, IMajorRecordGetter to)
    {
        foreach (var (slotName, _, child) in EnumerateChildren(from).ToList())
        {
            var property = SlotProperty(to.GetType(), slotName, "transplant a child into");
            // Branch on the slot's shape, not the current value — a cleared list slot could in
            // principle be null, and SetValue'ing a single child into a list property would crash.
            var value = property.GetValue(to);
            if (value is System.Collections.IEnumerable and not string) ((dynamic)value).Add((dynamic)child);
            else property.SetValue(to, child);
        }
    }

    /// <summary>Child major records read non-destructively off a getter, so ingest captures parentage in
    /// the same pass that writes the parent. <c>SlotIndex</c> is preserved so compile reproduces the
    /// original list order.</summary>
    internal static IEnumerable<(string SlotName, int SlotIndex, IMajorRecordGetter Child)> EnumerateChildren(
        IMajorRecordGetter record)
    {
        foreach (var (fieldName, property) in ChildProperties.GetOrAdd(record.GetType(), ChildPropertiesOf))
        {
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

    private static readonly ConcurrentDictionary<Type, IReadOnlyList<(string FieldName, PropertyInfo Property)>> ChildProperties = new();

    private static IReadOnlyList<(string FieldName, PropertyInfo Property)> ChildPropertiesOf(Type recordType) =>
        EnumerateChildFieldsFor(recordType) is { } fields
            ? [.. fields.Select(fieldName => (fieldName, SlotProperty(recordType, fieldName, "read children from")))]
            : [];
}
