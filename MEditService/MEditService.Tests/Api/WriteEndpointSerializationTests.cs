using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;

namespace MEditService.Tests.Api;

/// <summary>
/// #673 at the write path's own front door: <c>WriteEndpointMapping.Execute</c> is the shared
/// skeleton all six write endpoints run through, so it is where an incoming write is ordered against
/// whatever write is already in flight.
///
/// <para>Deliberately at this seam rather than over HTTP. The property under test — the second
/// request's service call does not start until the first one's has returned — is about the ordering
/// of the two <c>execute</c> delegates, and driving it through Kestrel would add a scheduler, a
/// connection pool and a serializer between the assertion and the thing it asserts, none of which
/// make the race any more real. The delegates here stand in for real edits precisely so the
/// interleaving can be observed at all.</para>
/// </summary>
public sealed class WriteEndpointSerializationTests
{
    private static IResult Run(IndexWriteGate gate, Func<RecordEditResult> execute) =>
        WriteEndpointMapping.Execute(
            gate,
            logReceived: null,
            validate: () => null,
            execute: execute,
            onApplied: _ => Results.Ok(),
            onWriteFailure: _ => Results.Problem("write failed", statusCode: 500),
            onMalformedFormKey: null,
            onNoLoadOrder: ex => WriteEndpointMapping.NoLoadOrder(ex));

    /// <summary>
    /// AC1. The second request is not merely observed to "finish later" — it is observed to have
    /// started its service call only after the first one's had <i>completed</i>, which is the
    /// difference between serialized and lucky. Without the gate the second delegate runs while the
    /// first is still inside its 500ms of work and reads <c>firstFinished</c> as false.
    /// </summary>
    [Fact]
    public async Task ASecondWrite_DoesNotStartUntilTheFirstHasFinished()
    {
        var gate = new IndexWriteGate();
        using var firstIsInside = new ManualResetEventSlim();
        var firstFinished = false;
        bool? firstWasFinishedWhenSecondStarted = null;

        var first = Task.Run(() => Run(gate, () =>
        {
            firstIsInside.Set();
            Thread.Sleep(500);
            Volatile.Write(ref firstFinished, true);
            return RecordEditResult.Success();
        }));

        Assert.True(firstIsInside.Wait(TimeSpan.FromSeconds(10)));
        var second = Task.Run(() => Run(gate, () =>
        {
            firstWasFinishedWhenSecondStarted = Volatile.Read(ref firstFinished);
            return RecordEditResult.Success();
        }));

        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.IsType<Ok>(await first);
        Assert.IsType<Ok>(await second);
        Assert.True(
            firstWasFinishedWhenSecondStarted,
            "the second write's service call ran while the first was still applying");
    }

    /// <summary>
    /// AC5. Contention blocks, and a block that outlasts the timeout is a 503 — the backend is busy,
    /// not broken. Never the 500 <c>onWriteFailure</c> shape: nothing was attempted, so nothing is
    /// half-applied and there is no source file to report as unwritable.
    /// </summary>
    [Fact]
    public async Task AWriteThatWaitsOutTheTimeout_IsServiceUnavailable_NotAWriteFailure()
    {
        var gate = new IndexWriteGate(TimeSpan.FromMilliseconds(150));
        using var held = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var holder = Task.Run(() =>
        {
            using var _ = gate.Enter();
            held.Set();
            release.Wait(TimeSpan.FromSeconds(30));
        });
        Assert.True(held.Wait(TimeSpan.FromSeconds(10)));

        var executed = false;
        var result = Run(gate, () =>
        {
            executed = true;
            return RecordEditResult.Success();
        });

        release.Set();
        await holder.WaitAsync(TimeSpan.FromSeconds(30));

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(503, problem.StatusCode);
        Assert.False(executed, "the write ran anyway after failing to take the gate");
    }
}
