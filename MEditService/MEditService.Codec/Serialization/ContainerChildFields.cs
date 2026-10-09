using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using MEditService.Codec.Schema;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>Reading and writing a container's child major records through the members
/// <see cref="ContainerMembers"/> derives. Nothing is stripped.</summary>
public static class ContainerChildFields
{
    /// <summary>The child-major field names for <paramref name="recordType"/>, or null when it is not a
    /// known container shape, or its assembly is outside every game this build references.</summary>
    internal static IReadOnlyList<string>? EnumerateChildFieldsFor(Type recordType) =>
        ContainerMembers.CategoryOf(recordType.Assembly) is { } category
        && ContainerMembers.Derived.ChildFieldsByType.TryGetValue((category, RecordTypes.ClassNameOf(recordType)), out var fields)
            ? fields
            : null;

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
    /// cell) takes it as its value unless it already holds <paramref name="held"/>.</summary>
    internal static bool TryAddChildToSlot(
        IMajorRecordGetter parent, string slotName, IMajorRecord child, [NotNullWhen(false)] out IMajorRecordGetter? held)
    {
        var property = SlotProperty(parent.GetType(), slotName, "add a child to");
        held = null;

        if (typeof(System.Collections.IEnumerable).IsAssignableFrom(property.PropertyType))
        {
            var list = property.GetValue(parent)
                ?? throw new InvalidOperationException($"Expected {parent.GetType().Name}.{slotName} to hold a collection to add a child to.");
            ((dynamic)list).Add((dynamic)child);
            return true;
        }

        held = property.GetValue(parent) as IMajorRecordGetter;
        if (held != null) return false;
        property.SetValue(parent, child);
        return true;
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
    public static IEnumerable<(string SlotName, int SlotIndex, IMajorRecordGetter Child)> EnumerateChildren(
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
