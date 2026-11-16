using System.Reflection;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The record index a writer hands its write to: it keeps each hand, and answers it as <see cref="Answer"/> does.
/// It serves no read.</summary>
public class HandedWrites : DispatchProxy
{
    private readonly List<IReadOnlyList<HandedPlugin>?> _hands = [];

    public Func<Task<string?>> Answer { get; set; } = () => Task.FromResult<string?>(null);

    public IReadOnlyList<IReadOnlyList<HandedPlugin>?> Hands
    {
        get { lock (_hands) return [.. _hands]; }
    }

    public IQueries Queries => (IQueries)(object)this;

    public static HandedWrites Create() => (HandedWrites)(object)Create<IQueries, HandedWrites>();

    private readonly Dictionary<string, IReadOnlyList<string>> _changedOutside = [];

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        if (targetMethod?.Name == nameof(IQueries.GetChangedOutside))
            return _changedOutside.TryGetValue((string)args.Require()[0].Require(), out var held) ? held : [];
        if (targetMethod?.Name == nameof(IQueries.SetChangedOutside))
        {
            var (origin, plugins) = ((string)args.Require()[0].Require(), (IReadOnlyList<string>)args.Require()[1].Require());
            var before = _changedOutside.TryGetValue(origin, out var was) ? was : [];
            _changedOutside[origin] = plugins;
            return (IReadOnlyList<PluginAddress>)[.. before.Except(plugins).Concat(plugins.Except(before)).Select(name => new PluginAddress(name, origin))];
        }
        if (targetMethod?.Name != nameof(IQueries.Hold)) throw new NotSupportedException($"The record index here serves no {targetMethod?.Name}.");
        var (written, cancel) = ((IReadOnlyList<HandedPlugin>?)args.Require()[0], (CancellationToken)args.Require()[1].Require());
        lock (_hands) _hands.Add(written);
        return Answer().WaitAsync(cancel);
    }
}
