using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

/// <summary>ADR-0014's read side: a plain read of the sequence, and a bounded await that answers
/// whether a projection landed rather than sleeping the caller.</summary>
[Collection(WebHostCollection.Name)]
public sealed class ProjectionSequenceApiTests : IDisposable
{
    private readonly MEditHost _app = new();
    private readonly HttpClient _client;

    public ProjectionSequenceApiTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    private static object LoadOrderBody(PluginFixtureData fx) => new
    {
        plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
        gameDirectory = fx.DataFolder,
        instanceRoot = fx.InstanceRoot,
        gameRelease = "Fallout4",
    };

    [Fact]
    public async Task GetSequence_WithNoLoadOrder_ReturnsZero()
    {
        var sequence = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        Assert.Equal(0, sequence);
    }

    [Fact]
    public async Task PutLoadOrder_AdvancesTheSequence()
    {
        var before = await _client.GetFromJsonAsync<long>("/load-order/sequence");

        using var fx = new PluginFixtureBuilder("api-sequence-write")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .Build();
        (await _client.PutLoadOrderAndAwaitReady(LoadOrderBody(fx))).EnsureSuccessStatusCode();

        var after = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        Assert.True(after > before, $"expected the sequence to advance past {before}, got {after}");
    }

    [Fact]
    public async Task AwaitSequence_AlreadyAtLeastN_ReturnsTrueImmediately()
    {
        var current = await _client.GetFromJsonAsync<long>("/load-order/sequence");

        var response = await _client.GetAsync(new Uri($"/load-order/sequence/await?atLeast={current}&timeoutMs=5000", UriKind.Relative));

        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(result.GetProperty("reached").GetBoolean());
        Assert.True(result.GetProperty("sequence").GetInt64() >= current);
    }

    [Fact]
    public async Task AwaitSequence_NothingLands_ReturnsFalseWithinTheBound()
    {
        var current = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        var timer = Stopwatch.StartNew();

        var response = await _client.GetAsync(new Uri($"/load-order/sequence/await?atLeast={current + 1000}&timeoutMs=300", UriKind.Relative));

        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(result.GetProperty("reached").GetBoolean());
        // Bounded, not hung: generous slack over the 300 ms bound for CI jitter.
        Assert.True(timer.ElapsedMilliseconds < 3000, $"took {timer.ElapsedMilliseconds} ms for a 300 ms bound");
    }

    [Fact]
    public async Task AwaitSequence_ProjectionLandsWhileWaiting_ReturnsTrueAtTheLandedSequence()
    {
        var current = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        using var fx = new PluginFixtureBuilder("api-sequence-landing")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .Build();

        // Nothing but the write below can satisfy current + 1, so a true answer proves the await
        // observed that write land rather than a value already there when it was asked.
        var awaitTask = _client.GetAsync(new Uri($"/load-order/sequence/await?atLeast={current + 1}&timeoutMs=20000", UriKind.Relative));
        var put = await _client.PutAsJsonAsync("/load-order", LoadOrderBody(fx));
        put.EnsureSuccessStatusCode();

        var response = await awaitTask;
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(result.GetProperty("reached").GetBoolean());
        Assert.True(result.GetProperty("sequence").GetInt64() > current);
    }

    [Fact]
    public async Task AwaitSequence_NonPositiveTimeout_Returns400()
    {
        var response = await _client.GetAsync(new Uri("/load-order/sequence/await?atLeast=1&timeoutMs=0", UriKind.Relative));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
