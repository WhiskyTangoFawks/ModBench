using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.ModFolderAdapter;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class ArchiveContentsApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>, IDisposable
{
    private readonly ScratchDirectory _root = new("api-archive-contents-");

    private HttpClient Client => loaded.Client;

    public void Dispose() => _root.Dispose();

    [Fact]
    public async Task AnArchive_IsAnsweredWithTheFilesItHolds()
    {
        Assert.Null(new ArchivePacker(new ModFolderRepository()).Pack(
            _root, "Mod - Main.ba2", [new ArchiveFile("scripts/a.pex", () => new MemoryStream([1]))], new Ba2Variant(1, Ba2Contents.General, Compressed: false)));
        var archive = Path.Combine(_root, "Mod - Main.ba2");

        var response = await Client.PostJson("/archives/contents", $$"""{"gameRelease": "Fallout4", "archives": [{{System.Text.Json.JsonSerializer.Serialize(archive)}}]}""");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var contents = Assert.Single((await response.Body()).EnumerateArray());
        Assert.Equal(archive, contents.GetProperty("archive").GetString());
        Assert.Equal("scripts/a.pex", Assert.Single(contents.GetProperty("files").EnumerateArray()).GetString());
    }

    [Theory]
    [InlineData("""{"gameRelease": "Nowhere", "archives": ["/x.ba2"]}""")]
    [InlineData("""{"gameRelease": "Fallout4", "archives": []}""")]
    public async Task ARequestThatIsNotWhole_Is400(string body) =>
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.PostJson("/archives/contents", body)).StatusCode);

    [Fact]
    public async Task AFileOfAnArchive_IsAnsweredWithItsBytes_AndAMissingOneIs404()
    {
        Assert.Null(new ArchivePacker(new ModFolderRepository()).Pack(
            _root, "Mod - Main.ba2", [new ArchiveFile("scripts/a.pex", () => new MemoryStream([7, 8]))], new Ba2Variant(1, Ba2Contents.General, Compressed: false)));
        var archive = System.Text.Json.JsonSerializer.Serialize(Path.Combine(_root, "Mod - Main.ba2"));

        var found = await Client.PostJson("/archives/file", $$"""{"gameRelease": "Fallout4", "archive": {{archive}}, "file": "scripts/a.pex"}""");
        var missing = await Client.PostJson("/archives/file", $$"""{"gameRelease": "Fallout4", "archive": {{archive}}, "file": "scripts/b.pex"}""");

        Assert.Equal(HttpStatusCode.OK, found.StatusCode);
        Assert.Equal<byte[]>([7, 8], await found.Content.ReadAsByteArrayAsync());
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }
}
