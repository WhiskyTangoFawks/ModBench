using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class HeldLoadOrderApiTests : HostedTests
{
    private readonly TestPluginFixture _fixture;

    public HeldLoadOrderApiTests() => _fixture = Owned(TestPluginFixture.Create());

    private Dictionary<string, object> Body() => SnapshotPlugins.Body(_fixture.DataFolder, _fixture.InstanceRoot, _fixture.Plugins);

    private LoadOrderSnapshot Held => Services.GetRequiredService<LoadOrderHolder>().Require();

    [Fact]
    public async Task PutLoadOrder_TheArchivesAndStringsFilesItNames_AreTheOnesTheLoadOrderHolds()
    {
        StampedFile[] archives = [new(Path.Combine(_fixture.DataFolder, "Fallout4 - Interface.ba2"), "1/2/3"), new(Path.Combine(_fixture.DataFolder, "A - Main.ba2"), "4/5/6")];
        StampedFile[] stringsFiles = [new(Path.Combine(_fixture.DataFolder, "Strings", "A_en.STRINGS"), "7/8/9")];
        var body = Body();
        body["archives"] = archives;
        body["stringsFiles"] = stringsFiles;

        var response = await Client.PutLoadOrderAndAwaitReady(body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal<IEnumerable<StampedFile>>([archives, stringsFiles], [Held.Archives, Held.StringsFiles]);
    }

    [Fact]
    public async Task PutLoadOrder_ThePluginsOwnArchivesAndStringsFiles_AreTheOnesItsCopyHolds()
    {
        var handed = _fixture.Plugins[0] with
        {
            NamedStrings = new(
                [new StampedFile(Path.Combine(_fixture.DataFolder, "A - Main.ba2"), "1/2")],
                [new StampedFile(Path.Combine(_fixture.DataFolder, "Strings", "A_en.STRINGS"), "3/4")]),
        };
        var body = Body();
        body["plugins"] = _fixture.Plugins.Skip(1).Prepend(handed).Select(p => p.Wire);

        var response = await Client.PutLoadOrderAndAwaitReady(body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(handed.Strings, Held.Plugin(handed.Key)?.Strings);
    }

    [Fact]
    public async Task PutLoadOrder_AModThatIsNoSourceMod_HasNoSourceFolder_Returns200()
    {
        var body = Body();
        body["plugins"] = _fixture.Plugins.Select(p => new
        {
            p.Name,
            p.Path,
            p.Origin,
            Provider = new { Kind = "Mod", Mod = p.Origin, Folder = Path.GetDirectoryName(p.Path) },
            p.Strings.Archives,
            p.Strings.StringsFiles,
        });

        var response = await Client.PutLoadOrderAndAwaitReady(body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_APluginTheSnapshotDoesNotListAsActive_ComesBackOutsideTheLoadOrder()
    {
        var fx = Owned(new PluginFixtureBuilder("api-reconcile-disabled")
            .WithPlugin("Active.esp", mod => mod.Npcs.AddNew("FromActive"))
            .WithPlugin("Dormant.esp", mod => mod.Npcs.AddNew("FromDormant"), enabled: false)
            .BuildScattered());

        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        Assert.False((await Client.Plugin("Dormant.esp")).GetProperty("inLoadOrder").GetBoolean());
    }
}
