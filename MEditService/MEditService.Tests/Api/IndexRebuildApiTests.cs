using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Index;
using MEditService.LoadOrder;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>ADR-0014's Refresh rebuild, over its transport. The store is corrupted by hand, the
/// same reasoning as <see cref="ReconcileApiTests"/>: nothing else can make the index disagree
/// with a system of record no other door has touched.</summary>
[Collection(WebHostCollection.Name)]
public sealed class IndexRebuildApiTests : IDisposable
{
    private readonly WebApplicationFactory<Program> _app = new();
    private readonly HttpClient _client;

    private const string Origin = "RebuildMod";
    private const string Plugin = "Rebuild.esp";

    public IndexRebuildApiTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    private async Task<ScatteredFixtureData> LoadAndTrack()
    {
        var fx = new PluginFixtureBuilder("api-rebuild")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("RebuildNpc"), origin: Origin)
            .BuildScattered();
        var load = await PutLoadOrder(fx);
        load.EnsureSuccessStatusCode();
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();
        return fx;
    }

    private Task<HttpResponseMessage> PutLoadOrder(ScatteredFixtureData fx) => _client.PutAsJsonAsync("/load-order", new
    {
        gameDirectory = fx.GameDirectory,
        instanceRoot = fx.InstanceRoot,
        plugins = fx.Plugins.Where(p => p.Origin == Origin)
            .Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
        gameRelease = "Fallout4",
    });

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

    // A second connection succeeding proves the backend released its own handle by the time the
    // rebuild POST answers — the old store's own Connection is gone by then.
    private static long RecordRowCount(string indexPath)
    {
        using var connection = new DuckDBConnection($"DataSource={indexPath}");
        connection.Open();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM mirror.records";
        return Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    [Fact]
    public async Task RebuildingThenResendingTheLoadOrder_CorrectsARowNoReconcileCanFix()
    {
        using var fx = await LoadAndTrack();
        var formKey = await FirstNpcFormKey();
        CorruptTheStoredBody(formKey);

        var rebuild = await _client.PostAsJsonAsync("/index/rebuild", new { instanceRoot = fx.InstanceRoot, gameRelease = "Fallout4" });
        rebuild.EnsureSuccessStatusCode();

        // The endpoint's own job, proven directly on disk: the file the corrupted row lived in
        // holds nothing at all once the rebuild answers, not merely a self-healed row.
        Assert.Equal(0, RecordRowCount(IndexFile.For(fx.InstanceRoot)));

        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var record = await _client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString(formKey)}?plugin={Plugin}&origin={Origin}");
        Assert.Equal("RebuildNpc", record.GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task Rebuilding_NeverLetsTheProjectionSequenceRegress_WithinTheProcess()
    {
        using var fx = await LoadAndTrack();
        var before = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        Assert.True(before > 0, "sanity: loading and tracking must have advanced the sequence past 0");

        var rebuild = await _client.PostAsJsonAsync("/index/rebuild", new { instanceRoot = fx.InstanceRoot, gameRelease = "Fallout4" });
        rebuild.EnsureSuccessStatusCode();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var after = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        Assert.True(after >= before, $"sequence regressed from {before} to {after} across a rebuild");
    }

    [Fact]
    public async Task RebuildingAnInstanceRootThatDoesNotExist_Is400()
    {
        var rebuild = await _client.PostAsJsonAsync(
            "/index/rebuild", new { instanceRoot = Path.Combine(Path.GetTempPath(), "no-such-instance"), gameRelease = "Fallout4" });

        Assert.Equal(HttpStatusCode.BadRequest, rebuild.StatusCode);
    }
}
