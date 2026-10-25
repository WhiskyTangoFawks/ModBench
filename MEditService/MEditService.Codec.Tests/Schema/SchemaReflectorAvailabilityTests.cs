using MEditService.Codec.Schema;
using MEditService.Codec.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class SchemaReflectorAvailabilityTests
{
    [Fact]
    public void AReleaseWithNoCodec_IsRefusedAsUnsupported_NotAsAMissingFile()
    {
        var ex = Assert.Throws<UnsupportedGameReleaseException>(() => new SchemaReflector().GetSchemas(GameRelease.Oblivion));

        Assert.Equal("mEdit does not support Oblivion: it has no codec to read its plugins.", ex.Message);
    }

    [Fact]
    public void AReleaseWithNoCodec_IsWarnedOfOnce_NotOncePerCall()
    {
        var entries = LoggedWalk.Logging(reflector =>
        {
            Assert.Throws<UnsupportedGameReleaseException>(() => reflector.GetSchemas(GameRelease.Oblivion));
            Assert.Throws<UnsupportedGameReleaseException>(() => reflector.GetSchemas(GameRelease.Oblivion));
        });

        Assert.Single(entries, e =>
            e.Level == LogLevel.Warning && e.Message.Contains("Oblivion", StringComparison.Ordinal) && e.Message.Contains("Mutagen.Bethesda.Oblivion", StringComparison.Ordinal));
    }
}
