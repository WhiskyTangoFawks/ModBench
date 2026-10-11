using System.Collections;
using System.Collections.Concurrent;
using System.Reflection;

namespace MEditService.Codec.Serialization;

/// <summary>Every node of a record's object graph whose type <paramref name="picks"/>, reached only through
/// the members that can hold one.</summary>
public sealed class RecordGraph(Func<Type, bool> picks)
{
    private readonly ConcurrentDictionary<Assembly, IReadOnlySet<Type>> _holdersByGame = new();
    private readonly ConcurrentDictionary<Type, PropertyInfo[]> _reachingByType = new();

    public bool CanReach(Type type) => CanHold(type, HoldersOf(type.Assembly));

    public void ForEach(object graph, Action<object> visit) => Visit(graph, HoldersOf(graph.GetType().Assembly), visit);

    private IReadOnlySet<Type> HoldersOf(Assembly game) => _holdersByGame.GetOrAdd(game, HoldersIn);

    private void Visit(object? node, IReadOnlySet<Type> holders, Action<object> visit)
    {
        if (node is null) return;
        var type = node.GetType();
        if (picks(type))
        {
            visit(node);
            return;
        }
        if (node is IEnumerable items and not string)
        {
            foreach (var item in items) Visit(item, holders, visit);
            return;
        }
        var reaching = _reachingByType.GetOrAdd(type, declaring =>
            [.. declaring.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.CanRead && p.GetIndexParameters().Length == 0 && CanHold(p.PropertyType, holders))]);
        foreach (var property in reaching) Visit(property.GetValue(node), holders, visit);
    }

    // The game's types a picked node can be reached through: a type with a member that can hold one,
    // or an abstract type one of them derives from, found by walking those edges back from the holders.
    private IReadOnlySet<Type> HoldersIn(Assembly game)
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
                if (picks(component) && holders.Add(type)) pending.Enqueue(type);
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

    private bool CanHold(Type declared, IReadOnlySet<Type> holders) =>
        picks(declared)
        || holders.Contains(declared)
        || (declared.IsGenericType && declared.GetGenericArguments().Any(argument => CanHold(argument, holders)))
        || (declared.GetElementType() is { } element && CanHold(element, holders));
}
