using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class DecompileAndRepairApiTests : HostedTests
{
    private const string Origin = "NewMod";
    private static readonly MalformationFixture Fixture = MalformationFixtures.ShortRegion;

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("api-decompile-and-repair")
        .WithPlugin(Fixture.Malformed.FileName, origin: Origin)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    [Fact]
    public async Task AMalformedPlugin_IsRepaired_AndAnswersItApplied()
    {
        File.WriteAllBytes(Path.Combine(OtherTool.ModFolderOf(_instance, Origin), Fixture.Malformed.FileName), Fixture.Malformed.Bytes);
        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();
        var plugin = new { name = Fixture.Malformed.FileName, origin = Origin };

        var repaired = await (await Client.PostAsJsonAsync("/plugins/decompile-and-repair", new
        {
            plugins = new[]
            {
                new
                {
                    plugin,
                    sourceFolder = new { sourceFolder = Client.SourceFolderSentFor(Origin), buildFile = "{}" },
                    @in = "NewRepository",
                },
            },
            force = false,
        })).EnsureSuccessStatusCode().Body();

        Assert.Equal([Fixture.Malformed.FileName], repaired.GetProperty("applied").EnumerateArray().Select(p => p.GetProperty("name").GetString()));
    }

    [Fact]
    public async Task ARepairHandingASourceFolderWithNoBuildFile_Is400()
    {
        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

        var response = await Client.PostAsJsonAsync("/plugins/decompile-and-repair", new
        {
            plugins = new[] { new { plugin = new { name = Fixture.Malformed.FileName, origin = Origin }, sourceFolder = new { sourceFolder = "s" }, @in = "NewRepository" } },
            force = false,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task ARepairHandingASourceFolderWithNoRepositoryToHoldIt_Is400()
    {
        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

        var response = await Client.PostAsJsonAsync("/plugins/decompile-and-repair", new
        {
            plugins = new[] { new { plugin = new { name = Fixture.Malformed.FileName, origin = Origin }, sourceFolder = new { sourceFolder = "s", buildFile = "{}" } } },
            force = false,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
