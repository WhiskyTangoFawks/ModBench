using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class LoadOrderStatusApiTests : IDisposable
{
    private readonly MEditHost _app = new();
    private readonly HttpClient _client;

    public LoadOrderStatusApiTests() => _client = _app.CreateClient();

    [Fact]
    public async Task GetLoadOrderStatus_WithNoLoadOrder_Returns200AndStateNone()
    {
        var response = await _client.GetAsync(new Uri("/load-order/status", UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var status = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("None", status.GetProperty("state").GetString());
        Assert.False(status.GetProperty("conflictsComputed").GetBoolean());
        Assert.Empty(status.GetProperty("indexedPlugins").EnumerateArray());
    }

    [Fact]
    public async Task GetLoadOrderStatus_AfterALoad_ReportsReadyWithEveryPluginAndItsOrigin()
    {
        using var fx = new PluginFixtureBuilder("api-status")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .Build();

        var load = await _client.PutLoadOrderAndAwaitReady(new
        {
            plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(fx.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(fx.Plugins),
            gameDirectory = fx.DataFolder,
            instanceRoot = fx.InstanceRoot,
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var status = await _client.GetFromJsonAsync<JsonElement>("/load-order/status");
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Assert.True(status.GetProperty("conflictsComputed").GetBoolean());
        Assert.Equal(1, status.GetProperty("totalPlugins").GetInt32());

        var indexed = status.GetProperty("indexedPlugins").EnumerateArray().Single();
        Assert.Equal("A.esp", indexed.GetProperty("name").GetString());
        Assert.False(string.IsNullOrWhiteSpace(indexed.GetProperty("origin").GetString()));
        Assert.Empty(status.GetProperty("failures").EnumerateArray());
    }

    [Fact]
    public async Task PutLoadOrder_AnswersAppliedAtOnce_AndStatusReachesReadySeparately()
    {
        using var fx = new PluginFixtureBuilder("api-status-contract")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .Build();

        var load = await _client.PutAsJsonAsync("/load-order", new
        {
            plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(fx.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(fx.Plugins),
            gameDirectory = fx.DataFolder,
            instanceRoot = fx.InstanceRoot,
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.OK, load.StatusCode);
        var body = await load.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("applied").GetBoolean());

        await _client.AwaitTerminalLoadOrderStatus(body.GetProperty("version").GetInt64());
        var status = await _client.GetFromJsonAsync<JsonElement>("/load-order/status");
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Assert.True(status.GetProperty("conflictsComputed").GetBoolean());
    }

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }
}
