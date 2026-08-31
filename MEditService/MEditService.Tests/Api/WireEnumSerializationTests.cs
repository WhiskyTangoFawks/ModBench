using System.Text.Json;
using MEditService.Api.Endpoints;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Source;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace MEditService.Tests.Api;

/// <summary>
/// Every enum that reaches the wire serializes as its <b>member name</b>, not its numeric value.
///
/// <para>This is the premise the OpenAPI schema's enum types rest on (#627): Swashbuckle only
/// honors a per-enum <c>[JsonConverter(typeof(JsonStringEnumConverter))]</c> attribute, while
/// <c>Program.cs</c> registers that converter <i>globally</i> — so an enum without the attribute
/// gets described as a numeric union while actually serializing as a string, and the frontend has
/// to distrust its own generated type. Adding the attribute corrects the description and must
/// leave the bytes alone. That "must leave the bytes alone" is what this file pins: it passed
/// before the attributes were added and passes after, so a schema fix can never quietly become a
/// wire change.</para>
///
/// <para>Options come from the running app's DI (<c>ConfigureHttpJsonOptions</c>), never from a
/// hand-built <see cref="JsonSerializerOptions"/> — a local copy would keep passing if the global
/// converter registration were dropped, which is precisely the regression worth catching.</para>
/// </summary>
public sealed class WireEnumSerializationTests
{
    private static async Task<JsonSerializerOptions> AppSerializerOptionsAsync()
    {
        await using var app = new WebApplicationFactory<Program>();
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

    /// <summary>The one property whose <i>C# type</i> changed rather than merely gaining an
    /// attribute: <c>RebaseResponse.Outcome</c> was a <c>string</c> filled by
    /// <c>result.Outcome.ToString()</c>, and is now the <see cref="RebaseOutcome"/> enum itself.
    /// Enum <c>ToString()</c> and JsonStringEnumConverter both emit the bare member name, so the
    /// bytes are identical across that change. These exact expectations were asserted green
    /// against the old <c>string</c> property before the type changed and are unchanged after it —
    /// which is the evidence, rather than the reasoning, that no wire format moved.</summary>
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
