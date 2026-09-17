using System.Diagnostics;
using MEditService.Index.Tests.TestSupport;
using MEditService.Tests;
using MEditService.Tests.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>A subscribed reconcile runs on its own thread, so a test asserting its outcome waits
/// for the status it publishes rather than for a call to return.</summary>
internal static class Waits
{
    internal static async Task<bool> Until(Func<bool> condition, TimeSpan? timeout = null)
    {
        var limit = timeout ?? TimeSpan.FromSeconds(10);
        var elapsed = Stopwatch.StartNew();
        while (!condition())
        {
            if (elapsed.Elapsed > limit) return false;
            await Task.Delay(20);
        }
        return true;
    }

    internal static async Task<bool> CompletesWithin(Task task, TimeSpan timeout) =>
        await Task.WhenAny(task, Task.Delay(timeout)) == task;
}
