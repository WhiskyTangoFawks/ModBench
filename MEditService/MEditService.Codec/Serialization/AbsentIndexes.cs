using System.Collections;
using System.Collections.Concurrent;
using System.Reflection;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>Mutagen's serializer writes an alias or package-data index of 0 as nothing and reads nothing
/// as no index, which the serializer then cannot write. A read fills that index back in as 0.</summary>
public static class AbsentIndexes
{
    private static readonly ConcurrentDictionary<Assembly, IReadOnlySet<Type>> HoldersByGame = new();
    private static readonly ConcurrentDictionary<Type, PropertyInfo[]> ReachingByType = new();

    public static T Fill<T>(T graph) where T : notnull
    {
        Visit(graph, HoldersByGame.GetOrAdd(graph.GetType().Assembly, HoldersIn));
        return graph;
    }

    private static void Visit(object? node, IReadOnlySet<Type> holders)
    {
        if (node is null) return;
        var type = node.GetType();
        if (FormLinkOrIndexInterface(type) is { } formLinkOrIndex)
        {
            FillIndex(node, formLinkOrIndex);
            return;
        }
        if (node is IEnumerable items and not string)
        {
            foreach (var item in items) Visit(item, holders);
            return;
        }
        var reaching = ReachingByType.GetOrAdd(type, declaring =>
            [.. declaring.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.CanRead && p.GetIndexParameters().Length == 0 && CanHold(p.PropertyType, holders))]);
        foreach (var property in reaching) Visit(property.GetValue(node), holders);
    }

    private static void FillIndex(object formLinkOrIndex, Type @interface)
    {
        var usesLink = typeof(IFormLinkOrIndexGetter<>).MakeGenericType(@interface.GetGenericArguments())
            .GetMethod(nameof(IFormLinkOrIndexGetter<IMajorRecordGetter>.UsesLink))
            ?? throw new InvalidOperationException($"Expected '{@interface.Name}' to declare UsesLink.");
        if ((bool)(usesLink.Invoke(formLinkOrIndex, null) ?? true)) return;
        var index = @interface.GetProperty(nameof(IFormLinkOrIndex<IMajorRecordGetter>.Index))
            ?? throw new InvalidOperationException($"Expected '{@interface.Name}' to declare Index.");
        if (index.GetValue(formLinkOrIndex) is null) index.SetValue(formLinkOrIndex, 0u);
    }

    private static Type? FormLinkOrIndexInterface(Type type) =>
        type.GetInterfaces().Prepend(type).FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IFormLinkOrIndex<>));

    // The game's types a FormLinkOrIndex can be reached through: a type with a member that can hold one,
    // or an abstract type one of them derives from, found by walking those edges back from the holders.
    private static IReadOnlySet<Type> HoldersIn(Assembly game)
    {
        var referrers = new Dictionary<Type, List<Type>>();
        var holders = new HashSet<Type>();
        var pending = new Queue<Type>();
        foreach (var type in game.GetTypes().Where(t => t.IsClass || t.IsInterface))
        {
            var held = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.GetIndexParameters().Length == 0)
                .SelectMany(p => Components(p.PropertyType));
            foreach (var component in held)
            {
                if (FormLinkOrIndexInterface(component) is not null && holders.Add(type)) pending.Enqueue(type);
                if (!referrers.TryGetValue(component, out var list)) referrers[component] = list = [];
                list.Add(type);
            }
        }
        while (pending.TryDequeue(out var holder))
        {
            foreach (var referrer in referrers.GetValueOrDefault(holder, []).Where(holders.Add)) pending.Enqueue(referrer);
            foreach (var ancestor in holder.GetInterfaces().Append(holder.BaseType).OfType<Type>().Where(type => type.Assembly == game && holders.Add(type))) pending.Enqueue(ancestor);
        }
        return holders;
    }

    private static IEnumerable<Type> Components(Type declared) =>
        declared.GetGenericArguments().SelectMany(Components)
            .Concat(declared.GetElementType() is { } element ? Components(element) : [])
            .Append(declared);

    private static bool CanHold(Type declared, IReadOnlySet<Type> holders) =>
        FormLinkOrIndexInterface(declared) is not null
        || holders.Contains(declared)
        || (declared.IsGenericType && declared.GetGenericArguments().Any(argument => CanHold(argument, holders)))
        || (declared.GetElementType() is { } element && CanHold(element, holders));
}
