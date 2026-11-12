using System.Net;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class FilePathResolveApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private Task<HttpResponseMessage> Resolve(string recordType, string fieldPath, string given) =>
        loaded.Client.PostJson("/file-paths/resolve", JsonSerializer.Serialize(new
        {
            gameRelease = "Fallout4",
            recordType,
            fieldPath,
            text = JsonSerializer.Serialize(new { Diffuse = given }),
        }));

    [Fact]
    public async Task APathAFieldHolds_IsAnsweredAsTheFileInTheDataFolder()
    {
        var response = await Resolve("txst", "Diffuse", @"Decals\Stain_d.dds");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Textures/Decals/Stain_d.dds", (await response.Body()).GetProperty("dataPath").GetString());
    }

    [Theory]
    [InlineData("nope", "Diffuse", "Decals/Stain_d.dds")]
    [InlineData("txst", "Material", "Decals/Stain.bgsm")]
    [InlineData("txst", "Diffuse", "Data/Stain_d.dds")]
    public async Task APathThatNamesNoFile_Is400(string recordType, string fieldPath, string given)
    {
        var response = await Resolve(recordType, fieldPath, given);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
