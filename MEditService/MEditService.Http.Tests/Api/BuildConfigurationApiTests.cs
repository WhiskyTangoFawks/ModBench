using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class BuildConfigurationApiTests : HostedTests
{
    private readonly ScratchDirectory _sourceFolder = new("api-build-configuration-");

    protected override void DisposeFixtures() => _sourceFolder.Dispose();

    private string BuildJson => Path.Combine(_sourceFolder, "build.json");

    private Task<HttpResponseMessage> Change(object body) => Client.PostAsJsonAsync("/build-configuration", body);

    [Fact]
    public async Task ARenameAndAnExclusion_WriteTheBuildConfiguration_Is204()
    {
        File.WriteAllText(BuildJson, "{\"output\": \"Old Name\"}");

        var response = await Change(new { sourceFolder = _sourceFolder.Path, output = "New Name", exclude = new[] { "textures/a.dds" } });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("{\n  \"output\": \"New Name\",\n  \"exclude\": [\n    \"textures/a.dds\"\n  ]\n}\n", File.ReadAllText(BuildJson));
    }

    public static TheoryData<string?, string?, string[]> BadRequests => new()
    {
        { null, "New Name", [] },
        { "folder", "Sub/Name", [] },
        { "folder", "..", [] },
        { "folder", null, ["../outside.dds"] },
        { "folder", null, ["textures\\a.dds"] },
        { "folder", null, [] },
    };

    [Theory]
    [MemberData(nameof(BadRequests))]
    public async Task ARequestWithNoSourceFolder_AnOutputThatIsNoFolderName_APathOutsideTheMod_OrNothingToChange_Is400(
        string? sourceFolder, string? output, string[] exclude)
    {
        var response = await Change(new { sourceFolder = sourceFolder is null ? null : _sourceFolder.Path, output, exclude });

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ASourceFolderWithNoBuildConfiguration_Is422()
    {
        var response = await Change(new { sourceFolder = _sourceFolder.Path, output = "New Name" });

        Assert.Equal("Unreadable", (await response.AssertIsProblem(HttpStatusCode.UnprocessableEntity)).GetProperty("refusal").GetString());
    }

    [PosixFact]
    public async Task AConfigurationTheDiskWillNotLetBeWritten_Is500_AndIsLeftAsItWas()
    {
        File.WriteAllText(BuildJson, "{\"output\": \"Old Name\"}");
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
        Assert.Equal("{\"output\": \"Old Name\"}", File.ReadAllText(BuildJson));
    }
}
