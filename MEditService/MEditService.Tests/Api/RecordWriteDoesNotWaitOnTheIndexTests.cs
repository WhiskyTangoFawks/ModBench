using System.Text.Json;
using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>ADR-0015 invariant 2: a record gesture writes its system of record and returns, never
/// queuing behind the Index's projections. One door stands for all six: they share
/// <c>WriteEndpointMapping.Execute</c>.</summary>
public sealed class RecordWriteDoesNotWaitOnTheIndexTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    // Generous, so a slow box cannot turn "was served" into a failure: a write that took the gate
    // would wait out IndexWriteGate.DefaultTimeout instead, well past this window.
    private static readonly TimeSpan ServedWindow = TimeSpan.FromSeconds(15);

    [Fact]
    public async Task EditRecord_IsServed_WhileAProjectionHoldsTheIndexWriteGate()
    {
        var request = new RecordEditRequest(
            IndexedModFixture.PluginName, IndexedModFixture.ModFolderOrigin, RecordEditEnvelope.Set,
            [PathHop.Member("HeightMax")], JsonDocument.Parse("0.75").RootElement);

        Task<IResult> edit;
        using (new GateHeldElsewhere(_mod.Index.WriteGate))
        {
            edit = Task.Run(() => RecordEndpoints.EditRecord(
                _mod.Npc.ToString(), request, TestEditService.EditHandler(_mod.Holder), NullLogger.Instance));

            await Task.WhenAny(edit, Task.Delay(ServedWindow));
            Assert.True(edit.IsCompleted, "the record edit queued behind the Index's write gate");
        }

        var ok = Assert.IsType<Ok<RecordEditResponse>>(await edit);
        Assert.True(ok.Value!.Applied);
    }
}
