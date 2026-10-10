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

    [Fact]
    public void TheSiblingsInUseRows_RefuseAChangeFromACaller()
    {
        var rows = (IDictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>>)
            GameCodecs.For(GameRelease.Fallout4).SiblingsInUse;

        Assert.Throws<NotSupportedException>(rows.Clear);
        Assert.NotEmpty(rows);
    }
}
