using System.Reflection;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The record index a writer hands its write to: it keeps each hand and answers it as <see cref="Answer"/> does. Its
/// one read is the plugin of each record's winning copy, from Owners.</summary>
public class HandedWrites : DispatchProxy
{
    private readonly List<IReadOnlyList<HandedPlugin>?> _hands = [];

    public Func<Task<string?>> Answer { get; set; } = () => Task.FromResult<string?>(null);

    public IReadOnlyList<IReadOnlyList<HandedPlugin>?> Hands
    {
        get { lock (_hands) return [.. _hands]; }
    }

    public IQueries Queries => (IQueries)(object)this;

    /// <summary>The plugin of each FormKey's winning copy; one it does not name no plugin holds.</summary>
    public Dictionary<string, PluginAddress> Owners { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Why the record index cannot say who holds a record; null while it can.</summary>
    public IndexRefused? OwnersRefused { get; set; }

    /// <summary>The load order version and FormKeys of each ask for whose plugin holds them, in the order asked.</summary>
    public List<(long Version, IReadOnlyCollection<string> FormKeys)> OwnersAsked { get; } = [];

    public static HandedWrites Create() => (HandedWrites)(object)Create<IQueries, HandedWrites>();

    private readonly Dictionary<string, IReadOnlyList<string>> _changedOutside = [];

    /// <summary>What the writer last told of each plugin of a mod changed outside Modbench.</summary>
    public IReadOnlyList<string> ChangedOutside(string origin) => _changedOutside.TryGetValue(origin, out var held) ? held : [];

    private static Answer<T, IndexRefused> Answered<T>(T value) => value;

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        if (targetMethod?.Name == nameof(IQueries.SetChangedOutside))
        {
            var (origin, plugins) = ((string)args.Require()[0].Require(), (IReadOnlyList<string>)args.Require()[1].Require());
            var before = _changedOutside.TryGetValue(origin, out var was) ? was : [];
            _changedOutside[origin] = plugins;
            return (IReadOnlyList<PluginAddress>)[.. before.Except(plugins).Concat(plugins.Except(before)).Select(name => new PluginAddress(name, origin))];
        }
        if (targetMethod?.Name == nameof(IQueries.GetRecordOwnersForAWrite))
        {
            if (OwnersRefused is { } refused) return (Answer<IReadOnlyDictionary<string, IReadOnlyList<PluginAddress>>, IndexRefused>)refused;
            var (version, formKeys) = ((long)args.Require()[0].Require(), (IReadOnlyCollection<string>)args.Require()[1].Require());
            OwnersAsked.Add((version, formKeys));
            return Answered<IReadOnlyDictionary<string, IReadOnlyList<PluginAddress>>>(formKeys.Distinct(StringComparer.OrdinalIgnoreCase).ToDictionary(
                formKey => formKey, formKey => (IReadOnlyList<PluginAddress>)(Owners.TryGetValue(formKey, out var owner) ? [owner] : []),
                StringComparer.OrdinalIgnoreCase));
        }
        if (targetMethod?.Name != nameof(IQueries.Hold)) throw new NotSupportedException($"The record index here serves no {targetMethod?.Name}.");
        var (written, cancel) = ((IReadOnlyList<HandedPlugin>?)args.Require()[0], (CancellationToken)args.Require()[1].Require());
        lock (_hands) _hands.Add(written);
        return Answer().WaitAsync(cancel);
    }
}

internal static class HandedWritesOf
{
    internal static HandedWrites Handed(this IQueries queries) => (HandedWrites)queries;
}
