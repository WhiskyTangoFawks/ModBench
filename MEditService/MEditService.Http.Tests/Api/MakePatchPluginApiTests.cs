using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.Api;

public sealed class MakePatchPluginApiTests : HostedTests
{
    private const string Base = "Base.esp";
    private const string Mod = "PatchMod";
    private const string Patch = "Patch.esp";

    private string _npc = string.Empty;
    private string _interiorRef = string.Empty;
    private string _folder = string.Empty;

    private async Task Loaded()
    {
        var fx = Owned(new PluginFixtureBuilder("api-make-patch")
            .WithPlugin(Base, mod =>
            {
                _npc = mod.Npcs.AddNew("BaseNpc").FormKey.ToString();
                _interiorRef = SpatialPlugin.AddTo(mod).InteriorRef.FormKey.ToString();
            })
            .BuildScattered());
        _folder = Directory.CreateDirectory(Path.Combine(fx.Root, Mod)).FullName;
        (await Client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(
            fx.DataFolder, fx.InstanceRoot, fx.Plugins, places: new[] { new { name = Mod, folder = _folder } }))).EnsureSuccessStatusCode();
    }

    private async Task<object> Read(string formKey) => new
    {
        text = (await Client.GetFromJsonAsync<JsonElement>(
            $"/plugins/{Base}/records/{Uri.EscapeDataString(formKey)}/rendered-document?origin={Uri.EscapeDataString(PluginOrigin.DataDirectory)}")).GetProperty("text").GetString(),
    };

    private Task<HttpResponseMessage> Make(string name, IReadOnlyList<object> records) =>
        Client.PostAsJsonAsync("/plugins/make-patch", new { origin = Mod, name, records, flags = Array.Empty<string>() });

    [Fact]
    public async Task RecordsAScriptReads_MakeAPluginHoldingThem_EachInItsContainer()
    {
        await Loaded();

        var made = await Make(Patch, [await Read(_npc), await Read(_interiorRef)]);

        Assert.Equal(HttpStatusCode.OK, made.StatusCode);
        using var written = Fallout4Mod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName(Patch), Path.Combine(_folder, Patch)), Fallout4Release.Fallout4);
        var cell = written.Cells.Records.SelectMany(block => block.SubBlocks).SelectMany(subBlock => subBlock.Cells).Single();
        Assert.Equal((_npc, _interiorRef), (written.Npcs.Single().FormKey.ToString(), cell.Persistent.Single().FormKey.ToString()));
    }

    [Fact]
    public async Task MakingAPluginOverAFileAtItsPath_Is409_AndLeavesTheFile()
    {
        await Loaded();
        await File.WriteAllTextAsync(Path.Combine(_folder, Patch), "held");

        var made = await Make(Patch, [await Read(_npc)]);

        Assert.Equal(
            (HttpStatusCode.Conflict, "FileExists", "held"),
            (made.StatusCode, (await made.Body()).GetProperty("refusal").GetString(), await File.ReadAllTextAsync(Path.Combine(_folder, Patch))));
    }

    [Fact]
    public async Task MakingAPluginACompiledPluginOfItsModCompilesTo_Is409_EvenWithNoBinaryAtItsPath()
    {
        var fx = Owned(new PluginFixtureBuilder("api-make-patch-compiled").WithPlugin(Patch, origin: Mod).BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(Mod)).EnsureSuccessStatusCode();
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(plugin => plugin.Origin == Mod).Path) ?? throw new InvalidOperationException("A mod plugin has a folder.");
        File.Delete(Path.Combine(modFolder, Patch));
        (await Client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(
            fx.DataFolder, fx.InstanceRoot, fx.Plugins.Where(plugin => plugin.Origin != Mod),
            places: new[] { new { name = Mod, folder = modFolder, sourceFolder = modFolder } }))).EnsureSuccessStatusCode();

        var made = await Make(Patch, []);

        Assert.Equal(
            (HttpStatusCode.Conflict, "CompiledPlugin", false),
            (made.StatusCode, (await made.Body()).GetProperty("refusal").GetString(), File.Exists(Path.Combine(modFolder, Patch))));
    }

    [Fact]
    public async Task ARecordNamingNoFormKey_Is400_AndWritesNothing()
    {
        await Loaded();

        var made = await Make(Patch, [new { text = """{"EditorID": "Nameless"}""", recordType = "npc_" }]);

        Assert.Equal(
            (HttpStatusCode.BadRequest, "InvalidEnvelope", false),
            (made.StatusCode, (await made.Body()).GetProperty("refusal").GetString(), File.Exists(Path.Combine(_folder, Patch))));
    }

    [Fact]
    public async Task ARecordTheRecordIndexCannotYetPlace_Is503_NamingTheRecordIndexsRefusal()
    {
        await using var app = new MEditHost(services => FailingQueries.Replace(
            services, ownersRefused: new IndexRefused(IndexRefusal.IndexNotReady, "The record index is reading.")));
        var client = app.CreateClient();
        var fx = Owned(new PluginFixtureBuilder("api-make-patch-index").WithPlugin(Base).BuildScattered());
        var folder = Directory.CreateDirectory(Path.Combine(fx.Root, Mod)).FullName;
        (await client.PutAsJsonAsync("/load-order", SnapshotPlugins.Body(
            fx.DataFolder, fx.InstanceRoot, fx.Plugins, places: new[] { new { name = Mod, folder } }))).EnsureSuccessStatusCode();

        var made = await client.PostAsJsonAsync(
            "/plugins/make-patch", new { origin = Mod, name = Patch, records = new[] { new { text = $$"""{"FormKey": "000800:{{Base}}"}""" } }, flags = Array.Empty<string>() });

        Assert.Equal(
            (HttpStatusCode.ServiceUnavailable, "IndexNotReady"),
            (made.StatusCode, (await made.Body()).GetProperty("refusal").GetString()));
    }

    [Fact]
    public async Task ARecordCompileRefuses_Is422_NamingCompilesRefusal_AndWritesNothing()
    {
        await Loaded();
        var lackingWhatTheCodecWrites = new { text = $$"""{"FormKey": "000800:{{Patch}}", "EditorID": "Sparse"}""", recordType = "npc_" };

        var made = await Make(Patch, [lackingWhatTheCodecWrites]);

        Assert.Equal(
            (HttpStatusCode.UnprocessableEntity, "SourceDoesNotParse", false),
            (made.StatusCode, (await made.Body()).GetProperty("refusal").GetString(), File.Exists(Path.Combine(_folder, Patch))));
    }
}
