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
                    sourceFolder = new { path = Client.SourceFolderSentFor(Origin), @in = "NewRepository", buildFile = "{}" },
                },
            },
            force = false,
        })).EnsureSuccessStatusCode().Body();

        Assert.Equal([Fixture.Malformed.FileName], repaired.GetProperty("applied").EnumerateArray().Select(p => p.GetProperty("name").GetString()));
    }
}
