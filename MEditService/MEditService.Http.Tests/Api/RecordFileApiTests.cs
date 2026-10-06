using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class RecordFileApiTests : HostedTests
{
    private const string Plugin = "Filed.esp";
    private const string Origin = "FiledMod";

    private async Task<ScatteredFixtureData> Untracked()
    {
        var fx = Owned(new PluginFixtureBuilder("api-record-file")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FiledNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    private async Task<ScatteredFixtureData> Tracked()
    {
        var fx = await Untracked();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);
        return fx;
    }

    private Task<string> Npc() => Client.FormKeyNamed(Plugin, Origin, "npc_", "FiledNpc");

    private Task<HttpResponseMessage> FileOf(string formKey, string? origin = Origin) =>
        Client.GetAsync(new Uri(
            $"/plugins/{Plugin}/records/{Uri.EscapeDataString(formKey)}/file" + (origin is null ? string.Empty : $"?origin={origin}"),
            UriKind.Relative));

    private Task<HttpResponseMessage> RecordOf(string? path) =>
        Client.GetAsync(new Uri(
            "/plugin-source/record" + (path is null ? string.Empty : $"?path={Uri.EscapeDataString(path)}"), UriKind.Relative));

    [Fact]
    public async Task ATrackedCopysFile_HoldsThatCopy()
    {
        var fx = await Tracked();
        var npc = await Npc();

        var file = await FileOf(npc);
        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        var path = (await file.Body()).GetProperty("path").GetString().Require();
        Assert.Equal(
            Directory.EnumerateFiles(Path.GetDirectoryName(fx.Plugins.Single().Path).Require(), "FiledNpc - *.json", SearchOption.AllDirectories)
                .Single(),
            path);

        var record = await RecordOf(path);
        Assert.Equal(HttpStatusCode.OK, record.StatusCode);
        var held = await record.Body();
        Assert.Equal(
            (npc, Plugin, Origin),
            (held.GetProperty("formKey").GetString(), held.GetProperty("plugin").GetString(), held.GetProperty("origin").GetString()));
    }

    [Fact]
    public async Task ACopyNamedWithoutItsOrigin_Is400()
    {
        await Untracked();

        await (await FileOf(await Npc(), origin: null)).AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ACopyThePluginDoesNotHold_Is404()
    {
        await Untracked();

        await (await FileOf(await Npc(), origin: "AnotherMod")).AssertIsProblem(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task AFileNamedByNoAbsolutePath_Is400()
    {
        await Untracked();

        await (await RecordOf(Path.Combine("plugin-source", Plugin, "Npcs", "FiledNpc.json"))).AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task AFileThatHoldsNoRecord_Is422_SayingWhy()
    {
        var fx = await Untracked();

        var refused = await (await RecordOf(fx.Plugins.Single().Path)).AssertIsProblem(HttpStatusCode.UnprocessableEntity);

        Assert.Equal($"{fx.Plugins.Single().Path} is under no tracked plugin's source.", refused.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task TheFileOfACopy_BeforeAnyLoadOrder_Is503()
    {
        await (await FileOf($"000000:{Plugin}")).AssertIsProblem(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task TheRecordOfAFile_BeforeAnyLoadOrder_Is503()
    {
        await (await RecordOf(Path.GetFullPath("Filed.json"))).AssertIsProblem(HttpStatusCode.ServiceUnavailable);
    }
}
