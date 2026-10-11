using MEditService.Ports;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>Throws a test injects into the code under test.</summary>
internal static class Faults
{
    /// <summary>An exception of <paramref name="type"/>, which takes a message.</summary>
    internal static Exception Of(Type type) =>
        ((Exception?)Activator.CreateInstance(type, $"injected {type.Name}")).Require();

    /// <summary>Throws an exception of <paramref name="type"/> the first time it runs, and nothing after.</summary>
    internal static Action Once(Type type)
    {
        Exception? pending = Of(type);
        return () =>
        {
            if (Interlocked.Exchange(ref pending, null) is { } thrown) throw thrown;
        };
    }

    /// <summary>A publish hook that throws <paramref name="thrown"/> at each notification <paramref name="on"/> matches.</summary>
    internal static Action<INotification> On(Predicate<INotification> on, Exception thrown) => notification =>
    {
        if (on(notification)) throw thrown;
    };
}
