using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.TestSupport;

/// <summary>What a reflector of its own logs: the shared reflector logs nowhere and caches its walk,
/// and the walk logs at Debug, below the default floor.</summary>
internal static class LoggedWalk
{
    internal static List<LogEntry> Of(GameRelease release) => Logging(reflector => reflector.GetSchemas(release));

    internal static List<LogEntry> Logging(Action<SchemaReflector> walk)
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        walk(new SchemaReflector(factory.CreateLogger<SchemaReflector>()));
        return entries;
    }
}
