using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Serialization;

public sealed class GameCodecsTests
{
    [Fact]
    public void AGameWithNoRegisteredProject_IsRefusedByName()
    {
        var refusal = Assert.Throws<NotSupportedException>(() => GameCodecs.For(GameRelease.Oblivion));

        Assert.Contains("Oblivion", refusal.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4, 0)]
    [InlineData(GameRelease.SkyrimSE, 0)]
    [InlineData(GameRelease.Starfield, 0x800)]
    public void OnlyStarfield_NamesABlueprintBitInThePluginHeader(GameRelease release, int expected) =>
        Assert.Equal(expected, GameCodecs.For(release).BlueprintFlag);

    [Theory]
    [InlineData(GameRelease.Fallout4, "Master:1,Small:512")]
    [InlineData(GameRelease.SkyrimSE, "Master:1,Small:512")]
    [InlineData(GameRelease.Starfield, "Master:1,Light:256,Overlay:512,Medium:1024")]
    public void TheLoadFlags_AreTheHeaderFlagsButLocalized(GameRelease release, string expected) =>
        Assert.Equal(expected, string.Join(",", GameCodecs.For(release).LoadFlags.OrderBy(flag => flag.Value).Select(flag => $"{flag.Key}:{flag.Value}")));
}
