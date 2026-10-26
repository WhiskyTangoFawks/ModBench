using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class CloneSubmodulesApiTests : HostedTests
{
    private readonly ScratchDirectory _root = new("api-clone-submodules-");
    private readonly PinnedSubmodule _submodule;

    public CloneSubmodulesApiTests() => _submodule = new PinnedSubmodule(_root);

    protected override void DisposeFixtures()
    {
        _submodule.Dispose();
        _root.Dispose();
    }

    [Fact]
    public async Task AnAbsentSubmodule_IsClonedAtItsPin_AndNamedCloned()
    {
        var pin = _submodule.Commit(("Mod.manifest.json", "{\"output\": \"Mod\", \"files\": []}"));
        _submodule.Pin(pin);

        var response = await Client.PostAsJsonAsync("/clone-submodules", new { submodules = new[] { new { folder = _submodule.Folder, pin } } });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var answer = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_submodule.Folder, Assert.Single(answer.GetProperty("applied").EnumerateArray()).GetProperty("folder").GetString());
        Assert.Empty(answer.GetProperty("refused").EnumerateArray());
        Assert.True(File.Exists(Path.Combine(_submodule.Folder, "Mod.manifest.json")));
    }

    [Theory]
    [InlineData("""{"submodules": []}""")]
    [InlineData("""{"submodules": [{"folder": "/source/Mod"}]}""")]
    public async Task ARequestWithNoWholeSubmodule_Is400(string body) =>
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.PostJson("/clone-submodules", body)).StatusCode);
}
