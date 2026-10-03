using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.Index;
using MEditService.Ports;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace MEditService.Http.Tests.Api;

public sealed class WireEnumSerializationWithThePerEnumConverterSwashbuckleNeedsTests
{
    private static async Task<JsonSerializerOptions> SerializerOptionsFromTheRunningAppsDiAsync()
    {
        await using var app = new MEditHost();
        _ = app.CreateClient();
        return app.Services
            .GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>()
            .Value.SerializerOptions;
    }

    [Fact]
    public async Task WorkingTreeState_SerializesAsMemberName()
    {
        var options = await SerializerOptionsFromTheRunningAppsDiAsync();
        var json = JsonSerializer.Serialize(
            new RecordSummary("00000800:Fallout4.esm", "MyPatch.esp", 3, true, "Npc", "ModA", WorkingTreeState.Modified),
            options);

        Assert.Contains("\"workingTreeState\":\"Modified\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TrackPhase_SerializesAsMemberName()
    {
        var options = await SerializerOptionsFromTheRunningAppsDiAsync();
        var json = JsonSerializer.Serialize(new TrackProgress("ModA", TrackPhase.Serializing, 2, 5), options);

        Assert.Contains("\"phase\":\"Serializing\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LoadOrderState_SerializesAsMemberName()
    {
        var options = await SerializerOptionsFromTheRunningAppsDiAsync();
        var json = JsonSerializer.Serialize(LoadOrderStatus.None with { State = LoadOrderState.Reconciling }, options);

        Assert.Contains("\"state\":\"Reconciling\"", json, StringComparison.Ordinal);
    }
}
