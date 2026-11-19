using System.Text;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class SpriggitStampTests
{
    private static readonly IGameCodec Codec = GameCodecs.For(GameRelease.Fallout4);
    private static readonly ModKey Plugin = ModKey.FromFileName("Stamped.esp");

    private static byte[] StampOf(string package, string version) =>
        Encoding.UTF8.GetBytes($$"""{"PackageName":"{{package}}","Version":"{{version}}","Release":"Fallout4","ModKey":"Stamped.esp"}""");

    [Fact]
    public void TheStamp_IsSpriggitsMetaFile_HoldingPackageVersionReleaseAndModKey()
    {
        var stamp = SpriggitStamp.Of(Codec, Plugin, GameRelease.Fallout4);

        Assert.Equal("spriggit-meta.json", stamp.RelativePath);
        Assert.Equal(
            $$"""
              {
                "PackageName": "{{Codec.SpriggitPackage}}",
                "Version": "{{Codec.SpriggitVersion}}",
                "Release": "Fallout4",
                "ModKey": "Stamped.esp"
              }
              """.ReplaceLineEndings("\n"),
            Encoding.UTF8.GetString(stamp.Content));
    }

    [Fact]
    public void ThePackageNamesTheGameOfTheCodec()
    {
        Assert.Equal("Spriggit.Json.Fallout4", Codec.SpriggitPackage);
    }

    [Fact]
    public void TheVersionIsOneNoPublishedSpriggitCarries_WhileMutagenIsNotPublished()
    {
        Assert.Contains("modbench-dev", Codec.SpriggitVersion, StringComparison.Ordinal);
    }

    [Fact]
    public void AStampOfTheVersionTheCodecWrites_IsNotRefused()
    {
        Assert.Null(SpriggitStamp.WhyRefused(Codec, SpriggitStamp.Of(Codec, Plugin, GameRelease.Fallout4).Content));
    }

    [Fact]
    public void AStampOfAnotherVersion_IsRefused_NamingBothVersionsAndTheWaysOn()
    {
        var reason = SpriggitStamp.WhyRefused(Codec, StampOf(Codec.SpriggitPackage, "0.1.0"));

        Assert.NotNull(reason);
        Assert.Contains("0.1.0", reason, StringComparison.Ordinal);
        Assert.Contains(Codec.SpriggitVersion, reason, StringComparison.Ordinal);
        Assert.Contains("upgrade", reason, StringComparison.Ordinal);
        Assert.Contains("decompile", reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AStampOfAnotherPackage_IsRefused_NamingIt()
    {
        var reason = SpriggitStamp.WhyRefused(Codec, StampOf("Spriggit.Yaml.Fallout4", Codec.SpriggitVersion));

        Assert.Contains("Spriggit.Yaml.Fallout4", reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ASourceWithNoStamp_IsRefused()
    {
        Assert.NotNull(SpriggitStamp.WhyRefused(Codec, null));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("{}")]
    [InlineData("[]")]
    public void AStampThatIsNoJsonObjectNamingAPackageAndVersion_IsRefused(string text)
    {
        Assert.NotNull(SpriggitStamp.WhyRefused(Codec, Encoding.UTF8.GetBytes(text)));
    }

    [Fact]
    public void ARenamedPlugin_IsStampedWithItsNewName_AndTheVersionItHeld()
    {
        var held = StampOf(Codec.SpriggitPackage, "0.1.0");

        var text = Encoding.UTF8.GetString(SpriggitStamp.Renamed(held, ModKey.FromFileName("Other.esm")));

        Assert.Contains("\"ModKey\": \"Other.esm\"", text, StringComparison.Ordinal);
        Assert.Contains("\"Version\": \"0.1.0\"", text, StringComparison.Ordinal);
    }
}
