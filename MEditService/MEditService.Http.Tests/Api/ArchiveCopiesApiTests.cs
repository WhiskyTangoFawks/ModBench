using System.Net;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.ModFolderAdapter;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class ArchiveCopiesApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>, IDisposable
{
    private readonly ScratchDirectory _root = new("api-archive-copies-");

    private HttpClient Client => loaded.Client;

    public void Dispose() => _root.Dispose();

    private const string TheExtensionsDigestOfScript = "Zm84p1xofs8=";

    [Fact]
    public async Task TheCopiesOfAnArchive_AreAnsweredWithTheSizeAndHashOfEach()
    {
        Assert.Null(new ArchivePacker(new ModFolderRepository()).Pack(
            _root, "Mod - Main.ba2", [new ArchiveFile("scripts/a.pex", () => new MemoryStream("script"u8.ToArray()))], new Ba2Variant(1, Ba2Contents.General, Compressed: false)));
        var archive = JsonSerializer.Serialize(Path.Combine(_root, "Mod - Main.ba2"));

        var response = await Client.PostJson("/archives/copies", $$"""{"gameRelease": "Fallout4", "archive": {{archive}}, "files": ["scripts/a.pex"], "hashed": true}""");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var copy = Assert.Single((await response.Body()).EnumerateArray());
        Assert.Equal(("scripts/a.pex", 6L, TheExtensionsDigestOfScript), (copy.GetProperty("file").GetString(), copy.GetProperty("size").GetInt64(), copy.GetProperty("hash").GetString()));
    }

    [Fact]
    public async Task AnArchiveThatCannotBeRead_Is400()
    {
        var archive = Path.Combine(_root, "Mod - Main.ba2");
        await File.WriteAllTextAsync(archive, "BTDX but nothing after it");

        var response = await Client.PostJson("/archives/copies", $$"""{"gameRelease": "Fallout4", "archive": {{JsonSerializer.Serialize(archive)}}, "files": ["a.nif"]}""");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("""{"gameRelease": "Nowhere", "archive": "/x.ba2", "files": ["a.nif"]}""")]
    [InlineData("""{"gameRelease": "Fallout4", "archive": "/x.ba2", "files": []}""")]
    [InlineData("""{"gameRelease": "Fallout4", "archive": " ", "files": ["a.nif"]}""")]
    public async Task ARequestThatIsNotWhole_Is400(string body) =>
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.PostJson("/archives/copies", body)).StatusCode);
}
