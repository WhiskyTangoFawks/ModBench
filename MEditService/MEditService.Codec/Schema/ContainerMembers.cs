using System.Reflection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>The members holding child major records, read from each game module's own types.
/// EmbeddedSlots is the subset the embed customization accepts. Every dictionary is keyed by game
/// too: two games' classes can share a bare name.</summary>
internal sealed record ContainerMembers(
    IReadOnlyDictionary<(GameCategory Game, string Type), string[]> ChildFieldsByType,
    IReadOnlySet<(GameCategory Game, string ParentType, string Slot)> EmbeddedSlots,
    IReadOnlyDictionary<(GameCategory Game, string ParentType, string Slot), string> ElementTypeBySlot,
    IReadOnlyDictionary<(GameCategory Game, string ParentType, string Slot), IReadOnlyList<Type>> HeldTypesBySlot)
{
    public static ContainerMembers Derived => Instance.Value;

    private static readonly Lazy<ContainerMembers> Instance = new(Derive);

    // The fact GameRelease.ToCategory() gives a release, read off a type's own assembly instead, so
    // a Type-keyed lookup needs no release passed to it. Null outside every referenced game.
    internal static GameCategory? CategoryOf(Assembly assembly)
    {
        foreach (var category in Enum.GetValues<GameCategory>())
            if (SchemaReflector.GameModule(category) == assembly) return category;
        return null;
    }

    private static ContainerMembers Derive()
    {
        var childFields = new Dictionary<(GameCategory, string), SortedSet<string>>();
        var embedded = new HashSet<(GameCategory Game, string ParentType, string Slot)>();
        var elementTypes = new Dictionary<(GameCategory Game, string ParentType, string Slot), string>();
        var heldTypes = new Dictionary<(GameCategory Game, string ParentType, string Slot), IReadOnlyList<Type>>();

        foreach (var (category, assembly) in GameModules())
        {
            foreach (var recordType in RecordTypes(assembly))
            {
                foreach (var property in recordType.GetProperties())
                {
                    var held = HeldMajorTypes(property.PropertyType, assembly, []).ToList();
                    if (held.Count == 0) continue;
                    var embeds = TypedAsChildMajor(property.PropertyType);

                    var key = (category, recordType.Name);
                    if (!childFields.TryGetValue(key, out var members))
                        childFields[key] = members = new SortedSet<string>(StringComparer.Ordinal);
                    members.Add(property.Name);
                    if (embeds) embedded.Add((category, recordType.Name, property.Name));
                    heldTypes[(category, recordType.Name, property.Name)] = held;
                    if (ElementTypeOf(property.PropertyType) is { } element)
                        elementTypes[(category, recordType.Name, property.Name)] = element.Name;
                }
            }
        }

        return new ContainerMembers(
            childFields.ToDictionary(entry => entry.Key, entry => entry.Value.ToArray()),
            embedded,
            elementTypes,
            heldTypes);
    }

    /// <summary>A list slot's element, or a single-value slot's own type.</summary>
    internal static Type? ElementTypeOf(Type slotType) =>
        slotType.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault()
        ?? slotType;

    // Every game this build references, so a module added later needs no line here.
    private static IEnumerable<(GameCategory Category, Assembly Assembly)> GameModules()
    {
        foreach (var category in Enum.GetValues<GameCategory>())
            if (SchemaReflector.GameModule(category) is { } assembly)
                yield return (category, assembly);
    }

    private static IEnumerable<Type> RecordTypes(Assembly assembly) =>
        assembly.GetTypes().Where(type => type.IsClass && !type.IsAbstract && type.IsPublic
            && typeof(IMajorRecord).IsAssignableFrom(type));

    // What ICustomizationBuilder.EmbedRecordsInSameFile takes: a major record, or a list of them.
    private static bool TypedAsChildMajor(Type type) =>
        typeof(IMajorRecordGetter).IsAssignableFrom(type)
        || (type.IsGenericType && !IsFormLink(type)
            && type.GetGenericArguments().Any(typeof(IMajorRecordGetter).IsAssignableFrom));

    // A worldspace's blocks: a list of a plain class whose own members reach the cells. Those cells
    // have directories of their own, so the member carries containment without being embedded.
    private static IEnumerable<Type> HeldMajorTypes(Type type, Assembly module, HashSet<Type> seen)
    {
        if (!seen.Add(type) || IsFormLink(type)) return [];
        if (typeof(IMajorRecordGetter).IsAssignableFrom(type)) return [type];
        if (type.IsGenericType) return type.GetGenericArguments().SelectMany(arg => HeldMajorTypes(arg, module, seen));
        return type.Assembly == module
            ? type.GetProperties().SelectMany(property => HeldMajorTypes(property.PropertyType, module, seen))
            : [];
    }

    // A reference, never embedded content: without this every link member reads as containment.
    private static bool IsFormLink(Type type) =>
        type.IsGenericType && type.GetGenericTypeDefinition().Name.Contains("FormLink", StringComparison.Ordinal);
}
