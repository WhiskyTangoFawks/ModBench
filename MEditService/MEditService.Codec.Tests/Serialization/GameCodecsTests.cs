using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Serialization;

public sealed class GameCodecsTests
{
    [Fact]
    public void AGameWithNoRegisteredProject_IsRefusedByName()
    {
        var refusal = Assert.Throws<NotSupportedException>(() => GameCodecs.For(GameRelease.SkyrimSE));

        Assert.Contains("Skyrim", refusal.Message, StringComparison.Ordinal);
    }
}
