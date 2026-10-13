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
    public async Task ARenameAndAnExclusion_WrittenToTheBuildConfiguration_Is204()
    {
        File.WriteAllText(BuildJson, "{\"output\": \"Old Name\"}");

        var response = await Change(new { sourceFolder = _sourceFolder.Path, output = "New Name", exclude = new[] { "textures/a.dds" } });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    [Fact]
    public async Task ARequestWithNoSourceFolder_Is400() =>
        await (await Change(new { output = "New Name" })).AssertIsProblem(HttpStatusCode.BadRequest);

    public static TheoryData<string?, string?[]> BadChanges => new()
    {
        { "Sub/Name", [] },
        { "..", [] },
        { null, ["../outside.dds"] },
        { null, ["textures\\a.dds"] },
        { null, [null] },
        { null, [] },
    };

    [Theory]
    [MemberData(nameof(BadChanges))]
    public async Task AnOutputThatIsNoFolderName_APathOutsideTheMod_OrNothingToChange_Is400(string? output, string?[] exclude) =>
        await (await Change(new { sourceFolder = _sourceFolder.Path, output, exclude })).AssertIsProblem(HttpStatusCode.BadRequest);

    [Fact]
    public async Task ASourceFolderWithNoBuildConfiguration_Is422()
    {
        var response = await Change(new { sourceFolder = _sourceFolder.Path, output = "New Name" });

        Assert.Equal("Unreadable", (await response.AssertIsProblem(HttpStatusCode.UnprocessableEntity)).GetProperty("refusal").GetString());
    }

    [PosixFact]
    public async Task AConfigurationTheDiskWillNotLetBeWritten_Is500()
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
    }
}
