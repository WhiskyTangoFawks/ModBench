using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class FileReferencesApiTests : HostedTests
{
    [Fact]
    public async Task GetFileReferences_AfterALoad_AnswersEachCopyThatNamesTheFile()
    {
        var fx = Owned(new PluginFixtureBuilder("api-file-references")
            .WithPlugin("Holding.esp", mod => mod.TextureSets.AddNew("Holder").Diffuse = @"Decals\Stain_d.dds", origin: "HoldingMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var answer = await Client.GetFromJsonAsync<JsonElement>("/file-paths/references?path=Textures/Decals/Stain_d.dds");

        var copy = Assert.Single(answer.GetProperty("copies").EnumerateArray());
        Assert.Equal("HoldingMod", copy.GetProperty("plugin").GetProperty("origin").GetString());
        Assert.Equal(["Diffuse"], copy.GetProperty("fieldPaths").EnumerateArray().Select(path => path.GetString()));
    }
}
