using MEditService.Ports;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Throws a test injects into the code under test.</summary>
internal static class Faults
{
    /// <summary>An exception of <paramref name="type"/>, which takes a message.</summary>
    internal static Exception Of(Type type) =>
        ((Exception?)Activator.CreateInstance(type, $"injected {type.Name}")).Require();

    /// <summary>On its nth run, throws an exception of the nth of <paramref name="turns"/>; a null turn, or a run
    /// past the last, throws nothing.</summary>
    internal static Action InTurn(params Type?[] turns)
    {
        var run = -1;
        return () =>
        {
            var turn = Interlocked.Increment(ref run);
            if (turn < turns.Length && turns[turn] is { } type) throw Of(type);
        };
    }

    /// <summary>A publish hook that throws <paramref name="thrown"/> at each notification <paramref name="on"/> matches.</summary>
    internal static Action<INotification> On(Predicate<INotification> on, Exception thrown) => notification =>
    {
        if (on(notification)) throw thrown;
    };
}
