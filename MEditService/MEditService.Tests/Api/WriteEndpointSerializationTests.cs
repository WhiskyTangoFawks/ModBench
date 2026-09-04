using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;

namespace MEditService.Tests.Api;

/// <summary>At the <c>WriteEndpointMapping.Execute</c> seam rather than over HTTP: the property is
/// the ordering of two delegates, and Kestrel would add a scheduler, a pool and a serializer
/// between the assertion and the thing it asserts.</summary>
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

    [Fact]
    public void AWriteThatWaitsOutTheTimeout_IsServiceUnavailable_NotAWriteFailure()
    {
        var gate = new IndexWriteGate(TimeSpan.FromMilliseconds(150));

        IResult result;
        var executed = false;
        using (new GateHeldElsewhere(gate))
        {
            result = Run(gate, () =>
            {
                executed = true;
                return RecordEditResult.Success();
            });
        }

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(503, problem.StatusCode);
        Assert.False(executed, "the write ran anyway after failing to take the gate");
    }
}
