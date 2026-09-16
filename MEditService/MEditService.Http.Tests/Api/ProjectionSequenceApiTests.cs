using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Mvc.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Api;

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
    public async Task AwaitSequence_ProjectionLandsWhileWaiting_ReturnsTrueLongBeforeTheTimeoutElapses()
    {
        var current = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        using var fx = new PluginFixtureBuilder("api-sequence-landing")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .Build();

        var timer = Stopwatch.StartNew();
        var awaitTask = _client.GetAsync(new Uri($"/load-order/sequence/await?atLeast={current + 1}&timeoutMs=20000", UriKind.Relative));

        // Gives the await request time to actually start polling before the write lands, so this
        // exercises a real wait rather than the already-satisfied fast path above.
        await Task.Delay(200);
        (await _client.PutAsJsonAsync("/load-order", LoadOrderBody(fx))).EnsureSuccessStatusCode();

        var response = await awaitTask;
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(result.GetProperty("reached").GetBoolean());
        // Well under the 20 s bound: proves it returned once the projection landed, not after
        // waiting out the whole window.
        Assert.True(timer.ElapsedMilliseconds < 10_000, $"took {timer.ElapsedMilliseconds} ms to notice a landed write");
    }

    [Fact]
    public async Task AwaitSequence_NonPositiveTimeout_Returns400()
    {
        var response = await _client.GetAsync(new Uri("/load-order/sequence/await?atLeast=1&timeoutMs=0", UriKind.Relative));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
