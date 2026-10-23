using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class RecordDocumentApiTests : HostedTests
{
    private const string Plugin = "Filed.esp";
    private const string Origin = "FiledMod";

    private async Task<ScatteredFixtureData> NonCompiledPlugin()
    {
        var fx = Owned(new PluginFixtureBuilder("api-record-document")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FiledNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    private async Task<ScatteredFixtureData> CompiledPlugin()
    {
        var fx = await NonCompiledPlugin();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        return fx;
    }

    private Task<string> Npc() => Client.FormKeyNamed(Plugin, Origin, "npc_", "FiledNpc");

    private Task<HttpResponseMessage> DocumentOf(string formKey, string? origin = Origin) =>
        Client.GetAsync(new Uri(
            $"/plugins/{Plugin}/records/{Uri.EscapeDataString(formKey)}/document" + (origin is null ? string.Empty : $"?origin={origin}"),
            UriKind.Relative));

    private Task<HttpResponseMessage> RecordOf(string path) =>
        Client.GetAsync(new Uri(
            $"/plugin-source/record?path={Uri.EscapeDataString(path)}", UriKind.Relative));

    private static string NpcFile(ScatteredFixtureData fx) =>
        Directory.EnumerateFiles(Path.GetDirectoryName(fx.Plugins.Single().Path).Require(), "FiledNpc - *.json", SearchOption.AllDirectories)
            .Single();

    [Fact]
    public async Task ACompiledPluginCopy_IsInItsFile()
    {
        var fx = await CompiledPlugin();

        var file = await DocumentOf(await Npc());

        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        var document = await file.Body();
        Assert.Equal("OwnFile", document.GetProperty("kind").GetString());
        Assert.Equal(NpcFile(fx), document.GetProperty("location").GetString());
    }

    [Fact]
    public async Task ACompiledPluginCopysFile_HoldsThatCopy()
    {
        var fx = await CompiledPlugin();

        var record = await RecordOf(NpcFile(fx));

        Assert.Equal(HttpStatusCode.OK, record.StatusCode);
        var held = await record.Body();
        Assert.Equal(
            (await Npc(), Plugin, Origin),
            (held.GetProperty("formKey").GetString(), held.GetProperty("plugin").GetProperty("name").GetString(), held.GetProperty("plugin").GetProperty("origin").GetString()));
    }

    [Fact]
    public async Task ACompiledPluginCopyWhoseFileIsGone_Is404()
    {
        var fx = await CompiledPlugin();
        var npc = await Npc();

        File.Delete(NpcFile(fx));

        await (await DocumentOf(npc)).AssertIsProblem(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task ACopyTwoDocumentsClaim_Is422_SayingSo()
    {
        var fx = await CompiledPlugin();
        var npc = await Npc();

        File.Copy(NpcFile(fx), Path.Combine(Path.GetDirectoryName(NpcFile(fx)).Require(), $"Twin - {npc.Replace(':', '_')}.json"));

        var refused = await (await DocumentOf(npc)).AssertIsProblem(HttpStatusCode.UnprocessableEntity);
        Assert.Contains("More than one document", refused.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ACopyThePluginDoesNotHold_Is404()
    {
        await NonCompiledPlugin();

        await (await DocumentOf(await Npc(), origin: "AnotherMod")).AssertIsProblem(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task AFileNamedByNoAbsolutePath_Is400()
    {
        await NonCompiledPlugin();

        await (await RecordOf(Path.Combine("plugin-source", Plugin, "Npcs", "FiledNpc.json"))).AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task AGroupsMetadataFile_HoldsNoRecord_Is204()
    {
        var fx = await CompiledPlugin();
        var metadata = Path.Combine(Path.GetDirectoryName(NpcFile(fx)).Require(), "GroupRecordData.json");
        await File.WriteAllTextAsync(metadata, "{}");

        Assert.Equal(HttpStatusCode.NoContent, (await RecordOf(metadata)).StatusCode);
    }

    [Fact]
    public async Task AFileUnderNoCompiledPluginSource_Is422_SayingWhy()
    {
        var fx = await NonCompiledPlugin();
        var loose = Path.Combine(Path.GetDirectoryName(fx.Plugins.Single().Path).Require(), "Loose.json");

        var refused = await (await RecordOf(loose)).AssertIsProblem(HttpStatusCode.UnprocessableEntity);

        Assert.Equal($"{loose} is under no compiled plugin's source.", refused.GetProperty("detail").GetString());
    }
}
