using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class AbandonedRequestApiTests : HostedTests
{
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    private readonly TaskCompletionSource<CancellationToken> _read = new(TaskCreationOptions.RunContinuationsAsynchronously);

    protected override MEditHost CreateHost() => new(services => ParkingQueries.Replace(services, _read));

    [Fact]
    public async Task ARequestItsCallerAbandoned_CancelsTheReadItIsRunning()
    {
        using var left = new CancellationTokenSource();
        var request = Client.GetAsync("/plugins", left.Token);
        var token = await _read.Task.WaitAsync(Generous);
        Assert.False(token.IsCancellationRequested);

        await left.CancelAsync();

        Assert.True(token.WaitHandle.WaitOne(Generous), "The read's token stayed live after its caller left.");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
    }
}
