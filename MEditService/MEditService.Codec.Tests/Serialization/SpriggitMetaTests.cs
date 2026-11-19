using System.Text;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class SpriggitMetaTests
{
    private static readonly IGameCodec Codec = GameCodecs.For(GameRelease.Fallout4);
    private static readonly ModKey Plugin = ModKey.FromFileName("Fixture.esp");

    private static byte[] MetaOf(string package, string version) =>
        Encoding.UTF8.GetBytes($$"""{"PackageName":"{{package}}","Version":"{{version}}","Release":"Fallout4","ModKey":"Fixture.esp"}""");

    [Fact]
    public void TheMeta_IsSpriggitsMetaFile_HoldingPackageVersionReleaseAndModKey()
    {
        var meta = SpriggitMeta.Of(Codec, Plugin, GameRelease.Fallout4);

        Assert.Equal("spriggit-meta.json", meta.RelativePath);
        Assert.Equal(
            $$"""
              {
                "PackageName": "{{Codec.SpriggitPackage}}",
                "Version": "{{Codec.SpriggitVersion}}",
                "Release": "Fallout4",
                "ModKey": "Fixture.esp"
              }
              """.ReplaceLineEndings("\n"),
            Encoding.UTF8.GetString(meta.Content));
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
    public void TheSpriggitReleaseTheVersionNames_IsOfTheCommitTheSubmoduleIsPinnedAt()
    {
        var service = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(service, "Directory.Build.props"))) service = Path.GetDirectoryName(service) ?? throw new DirectoryNotFoundException("No Directory.Build.props above the test.");
        var submodule = Path.Combine(service, "vendor", "Spriggit");

        var checkedOut = GitProbe.Run(Path.Combine(submodule, ".git"), submodule, "rev-parse", "HEAD").Trim();

        var props = File.ReadAllText(Path.Combine(service, "Directory.Build.props"));
        Assert.Contains($"<SpriggitPinnedCommit>{checkedOut}</SpriggitPinnedCommit>", props, StringComparison.Ordinal);
    }

    [Fact]
    public void AMetaOfTheVersionTheCodecWrites_IsNotRefused()
    {
        Assert.Null(SpriggitMeta.WhyRefused(Codec, SpriggitMeta.Of(Codec, Plugin, GameRelease.Fallout4).Content));
    }

    [Fact]
    public void AMetaOfAnotherVersion_IsRefused_NamingBothVersionsAndTheWaysOn()
    {
        var reason = SpriggitMeta.WhyRefused(Codec, MetaOf(Codec.SpriggitPackage, "0.1.0"));

        Assert.Equal(
            $"the plugin source is {Codec.SpriggitPackage} 0.1.0. Modbench reads {Codec.SpriggitPackage} {Codec.SpriggitVersion}. " +
            "Move it to that version with Spriggit's upgrade command, or decompile the plugin afresh.",
            reason);
    }

    [Fact]
    public void AMetaOfAnotherPackage_IsRefused_NamingIt()
    {
        var reason = SpriggitMeta.WhyRefused(Codec, MetaOf("Spriggit.Yaml.Fallout4", Codec.SpriggitVersion));

        Assert.StartsWith($"the plugin source is Spriggit.Yaml.Fallout4 {Codec.SpriggitVersion}.", reason, StringComparison.Ordinal);
    }

    public static TheoryData<string, string?> UnreadableMetas => new()
    {
        { "it is missing, so the version of the plugin source is unknown", null },
        { "it names no package and version", "not json" },
        { "it names no package and version", "{}" },
        { "it names no package and version", "[]" },
        { "it names no package and version", """{"PackageName":1,"Version":2}""" },
    };

    [Theory]
    [MemberData(nameof(UnreadableMetas))]
    public void AMetaNoVersionCanBeReadFrom_IsRefused_PointingAtAFreshDecompileOnly(string why, string? text)
    {
        var reason = SpriggitMeta.WhyRefused(Codec, text is null ? null : Encoding.UTF8.GetBytes(text));

        Assert.Equal($"{why}. Modbench reads {Codec.SpriggitPackage} {Codec.SpriggitVersion}. Decompile the plugin afresh.", reason);
    }

    [Fact]
    public void ARenamedPlugin_IsNamedInItsMeta_TheVersionItHeldKept()
    {
        var held = MetaOf(Codec.SpriggitPackage, "0.1.0");

        Assert.True(SpriggitMeta.TryRenamed(held, ModKey.FromFileName("Other.esm"), out var renamed, out _));

        var text = Encoding.UTF8.GetString(renamed ?? []);
        Assert.Contains("\"ModKey\": \"Other.esm\"", text, StringComparison.Ordinal);
        Assert.Contains("\"Version\": \"0.1.0\"", text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    public void AMetaThatIsNoJsonObject_IsNotRenamed_SayingSo(string text)
    {
        Assert.False(SpriggitMeta.TryRenamed(Encoding.UTF8.GetBytes(text), Plugin, out var renamed, out var whyNot));
        Assert.Null(renamed);
        Assert.Equal("it is no JSON object.", whyNot);
    }
}
