using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Index;
using MEditService.LoadOrder;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>ADR-0015 invariant 4's reconcile request, over its transport. The store is corrupted by
/// hand because nothing else can make the index disagree with a system of record no other door has
/// touched.</summary>
[Collection(WebHostCollection.Name)]
public sealed class ReconcileApiTests : IDisposable
{
    private readonly WebApplicationFactory<Program> _app = new();
    private readonly HttpClient _client;

    private const string Origin = "ReconcileMod";
    private const string Plugin = "Reconcile.esp";

    public ReconcileApiTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    private async Task<ScatteredFixtureData> LoadAndTrack()
    {
        var fx = new PluginFixtureBuilder("api-reconcile")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ReconcileNpc"), origin: Origin)
            .BuildScattered();
        var load = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Where(p => p.Origin == Origin)
                .Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();
        return fx;
    }

    private async Task<string> FirstNpcFormKey()
    {
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()!;
    }

    private void CorruptTheStoredBody(string formKey)
    {
        var index = (DuckDbRecordIndex)_app.Services.GetRequiredService<IndexProjector>().Store!;
        DuckDbSql.ExecuteFor(index.Connection,
            "UPDATE mirror.records SET body = '{\"EditorID\": \"CorruptedInTheStore\"}' WHERE form_key = $1", formKey);
    }

    [Fact]
    public async Task ReconcilingOnePlugin_CorrectsTheRow_AdvancesTheSequence_AndNamesTheKeyOnTheStream()
    {
        using var fx = await LoadAndTrack();
        var formKey = await FirstNpcFormKey();
        CorruptTheStoredBody(formKey);
        var before = await _client.GetFromJsonAsync<long>("/load-order/sequence");

        using var streamResponse = await _client.GetAsync(
            new Uri("/notifications/stream", UriKind.Relative), HttpCompletionOption.ResponseHeadersRead);
        streamResponse.EnsureSuccessStatusCode();
        await using var stream = await streamResponse.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream);

        var reconcile = await _client.PostAsync(
            new Uri($"/index/reconcile?plugin={Plugin}&origin={Origin}", UriKind.Relative), content: null);
        reconcile.EnsureSuccessStatusCode();
        var body = await reconcile.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(1, body.GetProperty("plugins").GetInt32());
        Assert.Equal(1, body.GetProperty("rowsChanged").GetInt32());
        Assert.True(body.GetProperty("sequence").GetInt64() > before);

        var record = await _client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString(formKey)}?plugin={Plugin}&origin={Origin}");
        Assert.Equal("ReconcileNpc", record.GetProperty("editorId").GetString());

        var (kind, data) = await ReadOneEventAsync(reader, TimeSpan.FromSeconds(10));
        Assert.Equal("rows-changed", kind);
        Assert.Contains(formKey, data.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
    }

    [Fact]
    public async Task ReconcilingEveryPlugin_ReportsHowManyCopiesItCheckedAndHowManyRowsChanged()
    {
        using var fx = await LoadAndTrack();

        var reconcile = await _client.PostAsync(new Uri("/index/reconcile", UriKind.Relative), content: null);
        reconcile.EnsureSuccessStatusCode();
        var body = await reconcile.Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(body.GetProperty("plugins").GetInt32() >= 1);
        Assert.Equal(0, body.GetProperty("rowsChanged").GetInt32());
        Assert.Empty(body.GetProperty("failures").EnumerateArray());
    }

    [Fact]
    public async Task ReconcilingACopyTheLoadOrderDoesNotHold_Is404()
    {
        using var fx = await LoadAndTrack();

        var reconcile = await _client.PostAsync(
            new Uri("/index/reconcile?plugin=NoSuch.esp&origin=Nowhere", UriKind.Relative), content: null);

        Assert.Equal(HttpStatusCode.NotFound, reconcile.StatusCode);
    }

    [Fact]
    public async Task NamingAPluginWithoutAnOrigin_Is400()
    {
        using var fx = await LoadAndTrack();

        var reconcile = await _client.PostAsync(
            new Uri($"/index/reconcile?plugin={Plugin}", UriKind.Relative), content: null);

        Assert.Equal(HttpStatusCode.BadRequest, reconcile.StatusCode);
    }

    private static async Task<(string Kind, JsonElement Data)> ReadOneEventAsync(StreamReader reader, TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        string? kind = null;
        while (true)
        {
            var line = await reader.ReadLineAsync(cts.Token);
            if (line is null) continue;
            if (line.StartsWith("event: ", StringComparison.Ordinal))
                kind = line["event: ".Length..];
            else if (line.StartsWith("data: ", StringComparison.Ordinal))
                return (kind!, JsonDocument.Parse(line["data: ".Length..]).RootElement);
        }
    }
}
