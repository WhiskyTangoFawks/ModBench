using System.Text;
using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

/// <summary>The content hash is the name git gives the same bytes, so real git is the only honest
/// oracle: a SHA-1 computed the same way would pass with the header format wrong.</summary>
public class SourceRepositoryContentHashTests
{
    private static string GitHashObject(byte[] content)
    {
        var dir = Directory.CreateTempSubdirectory("medit-blobhash-");
        try
        {
            var file = Path.Combine(dir.FullName, "content.bin");
            File.WriteAllBytes(file, content);
            return GitProbe.Run(Path.Combine(dir.FullName, "no-such-gitdir"), dir.FullName, "hash-object", file).Trim();
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task ContentHash_ForARealRecordsSourceText_MatchesGitHashObject()
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
            GameRelease.Fallout4);
        var record = ((IFallout4ModGetter)overlay).Npcs.First();
        var body = await new RecordTextCodec(NullLogger<RecordTextCodec>.Instance)
            .SerializeToBytesAsync(record, GameRelease.Fallout4);

        Assert.NotEmpty(body);
        Assert.Equal(GitHashObject(body), SourceRepository.ContentHash(body));
    }

    [Theory]
    [InlineData("")]
    [InlineData("{}\n")]
    [InlineData("{\n  \"EditorID\": \"Réservé\"\n}\n")]
    [InlineData("{\n  \"Name\": \"日本語テキスト\"\n}\n")]
    public void ContentHash_ForBodiesGitCanAlsoHash_MatchesGitHashObject(string text)
    {
        var content = Encoding.UTF8.GetBytes(text);
        Assert.Equal(GitHashObject(content), SourceRepository.ContentHash(content));
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
