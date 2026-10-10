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

        var ex = Assert.Throws<UnsupportedGameReleaseException>(() => reflector.GetSchemas(GameRelease.Oblivion));

        Assert.Equal("mEdit does not support Oblivion: it has no codec to read its plugins.", ex.Message);
    }

    [Fact]
    public void GetSchemas_ForUnsupportedRelease_LogsOneWarning_NotOncePerCall()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var reflector = new SchemaReflector(loggerFactory.CreateLogger<SchemaReflector>());

        Assert.Throws<UnsupportedGameReleaseException>(() => reflector.GetSchemas(GameRelease.Oblivion));
        Assert.Throws<UnsupportedGameReleaseException>(() => reflector.GetSchemas(GameRelease.Oblivion));

        var warnings = entries.Where(e =>
            e.Level == LogLevel.Warning && e.Message.Contains("Oblivion") && e.Message.Contains("Mutagen.Bethesda.Oblivion"))
            .ToList();
        Assert.Single(warnings);
    }
}
