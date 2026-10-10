using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class RecordDocumentApiTests : HostedTests
{
    private const string Plugin = "Filed.esp";
    private const string Origin = "FiledMod";

    private async Task<ScatteredFixtureData> Untracked()
    {
        var fx = Owned(new PluginFixtureBuilder("api-record-document")
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

    private Task<HttpResponseMessage> DocumentOf(string formKey, string? origin = Origin) =>
        Client.GetAsync(new Uri(
            $"/plugins/{Plugin}/records/{Uri.EscapeDataString(formKey)}/document" + (origin is null ? string.Empty : $"?origin={origin}"),
            UriKind.Relative));

    private Task<HttpResponseMessage> RecordOf(string? path) =>
        Client.GetAsync(new Uri(
            "/plugin-source/record" + (path is null ? string.Empty : $"?path={Uri.EscapeDataString(path)}"), UriKind.Relative));

    private static string NpcFile(ScatteredFixtureData fx) =>
        Directory.EnumerateFiles(Path.GetDirectoryName(fx.Plugins.Single().Path).Require(), "FiledNpc - *.json", SearchOption.AllDirectories)
            .Single();

    [Fact]
    public async Task ATrackedCopy_IsInItsFile()
    {
        var fx = await Tracked();

        var file = await DocumentOf(await Npc());

        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        var document = await file.Body();
        Assert.Equal("OwnFile", document.GetProperty("kind").GetString());
        Assert.Equal(NpcFile(fx), document.GetProperty("location").GetString());
    }

    [Fact]
    public async Task ATrackedCopysFile_HoldsThatCopy()
    {
        var fx = await Tracked();

        var record = await RecordOf(NpcFile(fx));

        Assert.Equal(HttpStatusCode.OK, record.StatusCode);
        var held = await record.Body();
        Assert.Equal(
            (await Npc(), Plugin, Origin),
            (held.GetProperty("formKey").GetString(), held.GetProperty("plugin").GetString(), held.GetProperty("origin").GetString()));
    }

    [Fact]
    public async Task ATrackedCopyWhoseFileIsGone_Is404()
    {
        var fx = await Tracked();
        var npc = await Npc();

        File.Delete(NpcFile(fx));

        await (await DocumentOf(npc)).AssertIsProblem(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task ACopyTwoDocumentsClaim_Is422_SayingSo()
    {
        var fx = await Tracked();
        var npc = await Npc();

        File.Copy(NpcFile(fx), Path.Combine(Path.GetDirectoryName(NpcFile(fx)).Require(), $"Twin - {npc.Replace(':', '_')}.json"));

        var refused = await (await DocumentOf(npc)).AssertIsProblem(HttpStatusCode.UnprocessableEntity);
        Assert.Contains("More than one document", refused.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ACopyNamedWithoutItsOrigin_Is400()
    {
        await Untracked();

        await (await DocumentOf(await Npc(), origin: null)).AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ACopyThePluginDoesNotHold_Is404()
    {
        await Untracked();

        await (await DocumentOf(await Npc(), origin: "AnotherMod")).AssertIsProblem(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task AFileNamedByNoAbsolutePath_Is400()
    {
        await Untracked();

        await (await RecordOf(Path.Combine("plugin-source", Plugin, "Npcs", "FiledNpc.json"))).AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task AGroupsMetadataFile_HoldsNoRecord_Is204()
    {
        var fx = await Tracked();
        var metadata = Path.Combine(Path.GetDirectoryName(NpcFile(fx)).Require(), "GroupRecordData.json");
        await File.WriteAllTextAsync(metadata, "{}");

        Assert.Equal(HttpStatusCode.NoContent, (await RecordOf(metadata)).StatusCode);
    }

    [Fact]
    public async Task AFileUnderNoTrackedSource_Is422_SayingWhy()
    {
        var fx = await Untracked();
        var loose = Path.Combine(Path.GetDirectoryName(fx.Plugins.Single().Path).Require(), "Loose.json");

        var refused = await (await RecordOf(loose)).AssertIsProblem(HttpStatusCode.UnprocessableEntity);

        Assert.Equal($"{loose} is under no tracked plugin's source.", refused.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task TheDocumentOfACopy_BeforeAnyLoadOrder_Is503()
    {
        await (await DocumentOf($"000000:{Plugin}")).AssertIsProblem(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task TheRecordOfAFile_BeforeAnyLoadOrder_Is503()
    {
        await (await RecordOf(Path.GetFullPath("Filed.json"))).AssertIsProblem(HttpStatusCode.ServiceUnavailable);
    }
}
