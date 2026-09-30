using System.Reflection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>The members holding child major records, read from each game module's own types.
/// <see cref="EmbeddedSlots"/> is the subset the embed customization accepts. ChildFieldsByType is
/// keyed by game too: two games' classes can share a bare name.</summary>
public sealed record ContainerMembers(
    IReadOnlyDictionary<(GameCategory Game, string Type), string[]> ChildFieldsByType,
    IReadOnlySet<(string ParentType, string Slot)> EmbeddedSlots,
    IReadOnlyDictionary<(string ParentType, string Slot), string> ElementTypeBySlot)
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
        var embedded = new HashSet<(string ParentType, string Slot)>();
        var elementTypes = new Dictionary<(string ParentType, string Slot), string>();

        foreach (var (category, assembly) in GameModules())
        {
            foreach (var recordType in RecordTypes(assembly))
            {
                foreach (var property in recordType.GetProperties())
                {
                    var embeds = TypedAsChildMajor(property.PropertyType);
                    if (!embeds && !ReachesChildMajor(property.PropertyType, assembly, [])) continue;

                    var key = (category, recordType.Name);
                    if (!childFields.TryGetValue(key, out var members))
                        childFields[key] = members = new SortedSet<string>(StringComparer.Ordinal);
                    members.Add(property.Name);
                    if (embeds) embedded.Add((recordType.Name, property.Name));
                    if (ElementTypeOf(property.PropertyType) is { } element)
                        elementTypes[(recordType.Name, property.Name)] = element.Name;
                }
            }
        }

        return new ContainerMembers(
            childFields.ToDictionary(entry => entry.Key, entry => entry.Value.ToArray()),
            embedded,
            elementTypes);
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
    private static bool ReachesChildMajor(Type type, Assembly module, HashSet<Type> seen)
    {
        if (!seen.Add(type) || IsFormLink(type)) return false;
        if (typeof(IMajorRecordGetter).IsAssignableFrom(type)) return true;
        if (type.IsGenericType) return type.GetGenericArguments().Any(arg => ReachesChildMajor(arg, module, seen));
        return type.Assembly == module
            && type.GetProperties().Any(property => ReachesChildMajor(property.PropertyType, module, seen));
    }

    // A reference, never embedded content: without this every link member reads as containment.
    private static bool IsFormLink(Type type) =>
        type.IsGenericType && type.GetGenericTypeDefinition().Name.Contains("FormLink", StringComparison.Ordinal);
}
