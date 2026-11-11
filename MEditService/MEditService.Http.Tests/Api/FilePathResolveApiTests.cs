using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class FilePathResolveApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private Task<HttpResponseMessage> Resolve(string recordType, string fieldPath, string value) =>
        loaded.Client.PostJson("/file-paths/resolve", $$"""{"gameRelease": "Fallout4", "recordType": "{{recordType}}", "fieldPath": "{{fieldPath}}", "value": "{{value}}"}""");

    [Fact]
    public async Task APathAFieldHolds_IsAnsweredAsTheFileInTheDataFolder()
    {
        var response = await Resolve("txst", "Diffuse", @"Decals\\Stain_d.dds");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Textures/Decals/Stain_d.dds", (await response.Body()).GetProperty("dataPath").GetString());
    }

    [Theory]
    [InlineData("txst", "EditorID")]
    [InlineData("txst", "Nope")]
    [InlineData("nope", "Diffuse")]
    public async Task AFieldThatIsNoPath_Is400(string recordType, string fieldPath)
    {
        var response = await Resolve(recordType, fieldPath, "x");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
