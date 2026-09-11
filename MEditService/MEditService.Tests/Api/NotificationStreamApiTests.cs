using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>ADR-0014 invariant 2, the first transport: the same rows-changed notification
/// <see cref="MEditService.Tests.Records.RowsChangedNotificationTests"/> observes through the
/// in-memory recorder, here observed through a real HTTP client on the SSE stream.</summary>
[Collection(WebHostCollection.Name)]
public sealed class NotificationStreamApiTests : IDisposable
{
    private readonly WebApplicationFactory<Program> _app = new();
    private readonly HttpClient _client;

    private const string Origin = "NotifyMod";
    private const string Plugin = "Notify.esp";

    public NotificationStreamApiTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-notify")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("NotifyNpc"), origin: Origin)
            .BuildScattered();

    private async Task LoadAndTrack(ScatteredFixtureData fx)
    {
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
    }

    private async Task<string> FirstNpcFormKey()
    {
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()!;
    }

    // Reads lines until one full "event:"/"data:" frame is assembled, bounded so a missed
    // notification fails the test instead of hanging the run.
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

    [Fact]
    public async Task WritingARecordThroughTheWriteApi_PublishesRowsChanged_WithTheKeyAndTheSequenceAfterTheWrite()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadAndTrack(fx);
        var formKey = await FirstNpcFormKey();

        using var streamResponse = await _client.GetAsync(
            new Uri("/notifications/stream", UriKind.Relative), HttpCompletionOption.ResponseHeadersRead);
        streamResponse.EnsureSuccessStatusCode();
        Assert.Equal("text/event-stream", streamResponse.Content.Headers.ContentType?.MediaType);
        await using var stream = await streamResponse.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream);

        var edit = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/edit",
            new { plugin = Plugin, origin = Origin, op = "set", path = new[] { new { kind = "member", name = "HeightMax" } }, value = 0.75 });
        edit.EnsureSuccessStatusCode();

        // The event comes first and the sequence is read after it: ADR-0014 makes the write and its
        // projection two events, so a read taken before the projection lands would name the sequence
        // as it stood before the rows changed.
        var (kind, data) = await ReadOneEventAsync(reader, TimeSpan.FromSeconds(10));
        var expectedSequence = await _client.GetFromJsonAsync<long>("/load-order/sequence");

        Assert.Equal("rows-changed", kind);
        Assert.Equal(Plugin, data.GetProperty("plugin").GetString());
        Assert.Equal(Origin, data.GetProperty("origin").GetString());
        Assert.Contains(formKey, data.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
        Assert.Equal(expectedSequence, data.GetProperty("sequence").GetInt64());
    }
}
