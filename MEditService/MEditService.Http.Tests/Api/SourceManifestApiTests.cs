using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class SourceManifestApiTests : HostedTests
{
    private readonly ScratchDirectory _sourceFolder = new("api-source-manifest-");

    protected override void DisposeFixtures() => _sourceFolder.Dispose();

    private string Manifest => Path.Combine(_sourceFolder, "Old Name.manifest.json");

    private Task<HttpResponseMessage> Change(object body) => Client.PostAsJsonAsync("/source-manifest", body);

    [Fact]
    public async Task ARenameAndAnExclusion_WrittenToTheManifest_Is204()
    {
        File.WriteAllText(Manifest, "{\"output\": \"Old Name\", \"files\": []}");

        var response = await Change(new { sourceFolder = _sourceFolder.Path, output = "New Name", exclude = new[] { "textures/a.dds" }, exclusionMark = ".mohidden" });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    public static TheoryData<string, string> NotAChange => new()
    {
        { "no source folder", """{"output": "New Name"}""" },
        { "a path that is null", """{"sourceFolder": "/source/Mod", "exclude": [null]}""" },
        { "paths without the exclusion mark", """{"sourceFolder": "/source/Mod", "exclude": ["a.dds"]}""" },
        { "nothing to change", """{"sourceFolder": "/source/Mod", "exclude": []}""" },
    };

    [Theory]
    [MemberData(nameof(NotAChange))]
    public async Task ARequestThatDoesNotSayWhatToChange_Is400(string lacking, string body)
    {
        var response = await Client.PostJson("/source-manifest", body);

        Assert.Equal((lacking, HttpStatusCode.BadRequest), (lacking, response.StatusCode));
    }

    [Fact]
    public async Task AnOutputThatIsNoFolderName_Is400_Refused_OutsideTheMod()
    {
        var response = await Change(new { sourceFolder = _sourceFolder.Path, output = "Sub/Name" });

        Assert.Equal("OutsideTheMod", (await response.AssertIsProblem(HttpStatusCode.BadRequest)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task ASourceFolderWithNoManifest_Is422()
    {
        var response = await Change(new { sourceFolder = _sourceFolder.Path, output = "New Name" });

        Assert.Equal("Unreadable", (await response.AssertIsProblem(HttpStatusCode.UnprocessableEntity)).GetProperty("refusal").GetString());
    }

    [PosixFact]
    public async Task AManifestTheDiskWillNotLetBeWritten_Is500()
    {
        File.WriteAllText(Manifest, "{\"output\": \"Old Name\", \"files\": []}");
        FileModes.Set(_sourceFolder, "555");
        HttpResponseMessage response;
        try
        {
            response = await Change(new { sourceFolder = _sourceFolder.Path, output = "New Name" });
        }
        finally
        {
            FileModes.Set(_sourceFolder, "755");
        }

        Assert.Equal("WriteFailed", (await response.AssertIsProblem(HttpStatusCode.InternalServerError)).GetProperty("refusal").GetString());
    }
}
