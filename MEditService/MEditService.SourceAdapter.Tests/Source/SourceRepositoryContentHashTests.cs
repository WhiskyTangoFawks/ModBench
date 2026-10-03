using System.Text;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.SourceAdapter.Tests.Source;

public class SourceRepositoryContentHashTests
{
    private static string TheNameRealGitGives(byte[] content)
    {
        using var dir = new ScratchDirectory("medit-blobhash-");
        var file = Path.Combine(dir, "content.bin");
        File.WriteAllBytes(file, content);
        return GitProbe.Run(Path.Combine(dir, "no-such-gitdir"), dir, "hash-object", file).Trim();
    }

    [Fact]
    public void ContentHash_ForARealRecordsSourceText_MatchesTheNameRealGitGives()
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
            GameRelease.Fallout4);
        var record = ((IFallout4ModGetter)overlay).Npcs.First();
        var body = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance)
            .SerializeToBytes(record, GameRelease.Fallout4);

        Assert.NotEmpty(body);
        Assert.Equal(TheNameRealGitGives(body), SourceRepository.ContentHash(body));
    }

    [Theory]
    [InlineData("")]
    [InlineData("{}\n")]
    [InlineData("{\n  \"EditorID\": \"Réservé\"\n}\n")]
    [InlineData("{\n  \"Name\": \"日本語テキスト\"\n}\n")]
    public void ContentHash_ForBodiesGitCanAlsoHash_MatchesTheNameRealGitGives(string text)
    {
        var content = Encoding.UTF8.GetBytes(text);
        Assert.Equal(TheNameRealGitGives(content), SourceRepository.ContentHash(content));
    }

    [Fact]
    public void ContentHash_IsStableAcrossCallsAndDistinguishesDifferentBodies()
    {
        var a = Encoding.UTF8.GetBytes("{\n  \"Value\": 250\n}\n");
        var alsoA = Encoding.UTF8.GetBytes("{\n  \"Value\": 250\n}\n");
        var b = Encoding.UTF8.GetBytes("{\n  \"Value\": 251\n}\n");

        Assert.Equal(SourceRepository.ContentHash(a), SourceRepository.ContentHash(alsoA));
        Assert.NotEqual(SourceRepository.ContentHash(a), SourceRepository.ContentHash(b));
    }
}
