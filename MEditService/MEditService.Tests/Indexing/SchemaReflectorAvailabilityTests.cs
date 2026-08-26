using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

// #445: game discovery must skip an installed game whose Mutagen game assembly isn't referenced —
// log and continue, never throw. This build references only Mutagen.Bethesda.Fallout4 (see
// MEditService.Api.csproj), so GameRelease.SkyrimSE is a real (not mocked) "assembly not
// referenced" condition here — Mutagen.Bethesda.Skyrim.dll exists nowhere in the build output.
// That is deliberate: it is the same condition #423 will remove by adding the reference, at which
// point these tests' unsupported case moves to whatever remains unreferenced, with zero code
// changes required here (root generalization rule — no hardcoded game list).
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
    public void IsSupported_ReturnsFalseForReleaseWhoseAssemblyIsNotReferenced()
    {
        var reflector = new SchemaReflector();

        var supported = reflector.IsSupported(GameRelease.SkyrimSE);

        Assert.False(supported);
    }

    [Fact]
    public void IsSupported_ReturnsTrueForReferencedRelease()
    {
        // Guards against a stub that always returns false: Fallout4's assembly genuinely is
        // referenced, so this must come back true.
        var reflector = new SchemaReflector();

        var supported = reflector.IsSupported(GameRelease.Fallout4);

        Assert.True(supported);
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
    public void IsSupported_LogsOneWarning_NotOncePerCall()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var reflector = new SchemaReflector(loggerFactory.CreateLogger<SchemaReflector>());

        reflector.IsSupported(GameRelease.SkyrimSE);
        reflector.IsSupported(GameRelease.SkyrimSE);

        var warnings = entries.Where(e =>
            e.Level == LogLevel.Warning && e.Message.Contains("SkyrimSE") && e.Message.Contains("Mutagen.Bethesda.Skyrim"))
            .ToList();
        Assert.Single(warnings);
    }
}
