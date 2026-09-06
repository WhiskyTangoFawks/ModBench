using System.Reflection;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>The members holding child major records, read from each game module's own types.
/// <see cref="EmbeddedSlots"/> is the subset the embed customization accepts, and a container's
/// document carries exactly those.</summary>
internal sealed record ContainerMembers(
    IReadOnlyDictionary<string, string[]> ChildFieldsByType,
    IReadOnlySet<(string ParentType, string Slot)> EmbeddedSlots)
{
    internal static ContainerMembers Derived => Instance.Value;

    private static readonly Lazy<ContainerMembers> Instance = new(Derive);

    private static ContainerMembers Derive()
    {
        var childFields = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        var embedded = new HashSet<(string ParentType, string Slot)>();

        foreach (var assembly in GameModules())
        {
            foreach (var recordType in RecordTypes(assembly))
            {
                foreach (var property in recordType.GetProperties())
                {
                    var embeds = TypedAsChildMajor(property.PropertyType);
                    if (!embeds && !ReachesChildMajor(property.PropertyType, assembly, [])) continue;

                    if (!childFields.TryGetValue(recordType.Name, out var members))
                        childFields[recordType.Name] = members = new SortedSet<string>(StringComparer.Ordinal);
                    members.Add(property.Name);
                    if (embeds) embedded.Add((recordType.Name, property.Name));
                }
            }
        }

        return new ContainerMembers(
            childFields.ToDictionary(entry => entry.Key, entry => entry.Value.ToArray(), StringComparer.Ordinal),
            embedded);
    }

    // Every game this build references, so a module added later needs no line here.
    private static IEnumerable<Assembly> GameModules() =>
        Enum.GetValues<GameCategory>().Select(SchemaReflector.GameModule).OfType<Assembly>();

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
