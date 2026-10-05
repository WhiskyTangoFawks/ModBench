using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Indexing;

public sealed class SchemaReflectorAvailabilityTests
{
    private static (ILoggerFactory factory, List<LogEntry> entries) CapturingLoggerFactory()
    {
        var entries = new List<LogEntry>();
        var factory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Debug);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        return (factory, entries);
    }

    [Fact]
    public void GetSchemas_ForUnsupportedRelease_ThrowsUnsupportedGameReleaseException_NotFileNotFoundException()
    {
        var reflector = new SchemaReflector();

        var ex = Assert.Throws<UnsupportedGameReleaseException>(() => reflector.GetSchemas(GameRelease.SkyrimSE));

        Assert.Contains("SkyrimSE", ex.Message);
        Assert.Contains("Mutagen.Bethesda.Skyrim", ex.Message);
    }

    [Fact]
    public void GetSchemas_ForUnsupportedRelease_LogsOneWarning_NotOncePerCall()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var reflector = new SchemaReflector(loggerFactory.CreateLogger<SchemaReflector>());

        Assert.Throws<UnsupportedGameReleaseException>(() => reflector.GetSchemas(GameRelease.SkyrimSE));
        Assert.Throws<UnsupportedGameReleaseException>(() => reflector.GetSchemas(GameRelease.SkyrimSE));

        var warnings = entries.Where(e =>
            e.Level == LogLevel.Warning && e.Message.Contains("SkyrimSE") && e.Message.Contains("Mutagen.Bethesda.Skyrim"))
            .ToList();
        Assert.Single(warnings);
    }
}
