using System.Text.Json;
using MEditService.Api.Endpoints;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Source;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace MEditService.Tests.Api;

/// <summary>Swashbuckle only honors a per-enum <c>JsonStringEnumConverter</c> attribute while
/// <c>Program.cs</c> registers the converter globally, so adding the attribute must leave the bytes
/// alone.</summary>
[Collection(ApiTestCollection.Name)]
public sealed class WireEnumSerializationTests
{
    private static async Task<JsonSerializerOptions> AppSerializerOptionsAsync()
    {
        await using var app = new WebApplicationFactory<Program>();
        // Options come from the running app's DI: a hand-built JsonSerializerOptions would keep
        // passing if the global converter registration were dropped.
        // Force the host to build before resolving out of it.
        _ = app.CreateClient();
        return app.Services
            .GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>()
            .Value.SerializerOptions;
    }

    [Fact]
    public async Task WorkingTreeState_SerializesAsMemberName()
    {
        var options = await AppSerializerOptionsAsync();
        var json = JsonSerializer.Serialize(
            new RecordSummary("00000800:Fallout4.esm", "MyPatch.esp", 3, true, "Npc", "ModA", WorkingTreeState.Modified),
            options);

        Assert.Contains("\"workingTreeState\":\"Modified\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TrackPhase_SerializesAsMemberName()
    {
        var options = await AppSerializerOptionsAsync();
        var json = JsonSerializer.Serialize(new TrackProgress("ModA", TrackPhase.Serializing, 2, 5), options);

        Assert.Contains("\"phase\":\"Serializing\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CrashRepairReason_SerializesAsMemberName()
    {
        var options = await AppSerializerOptionsAsync();
        var json = JsonSerializer.Serialize(
            new CrashRepairOffer("MyPatch.esp", "ModA", CrashRepairReason.InterruptedCompile), options);

        Assert.Contains("\"reason\":\"InterruptedCompile\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LoadOrderState_SerializesAsMemberName()
    {
        var options = await AppSerializerOptionsAsync();
        var json = JsonSerializer.Serialize(LoadOrderStatus.None with { State = LoadOrderState.Reconciling }, options);

        Assert.Contains("\"state\":\"Reconciling\"", json, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(RebaseOutcome.Clean, "Clean")]
    [InlineData(RebaseOutcome.Refused, "Refused")]
    [InlineData(RebaseOutcome.Conflicted, "Conflicted")]
    public async Task RebaseResponseOutcome_SerializesAsMemberName(RebaseOutcome outcome, string expected)
    {
        var options = await AppSerializerOptionsAsync();
        var json = JsonSerializer.Serialize(new RebaseResponse(outcome, null, []), options);

        Assert.Contains($"\"outcome\":\"{expected}\"", json, StringComparison.Ordinal);
    }
}
