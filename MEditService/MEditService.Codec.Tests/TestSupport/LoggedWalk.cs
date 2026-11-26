using System.Collections.Concurrent;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.TestSupport;

/// <summary>What a reflector of its own logs: the shared reflector logs nowhere and caches its walk,
/// and the walk logs at Debug, below the default floor. A game's walk costs ~0.5 s, so it is logged once per run.</summary>
internal static class LoggedWalk
{
    private static readonly ConcurrentDictionary<GameRelease, Lazy<List<LogEntry>>> Walks = new();

    internal static IReadOnlyList<LogEntry> Of(GameRelease release) =>
        Walks.GetOrAdd(release, _ => new(() => Logging(reflector => reflector.GetSchemas(release)))).Value;

    internal static List<LogEntry> Logging(Action<SchemaReflector> walk)
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        walk(new SchemaReflector(factory.CreateLogger<SchemaReflector>()));
        return entries;
    }
}
