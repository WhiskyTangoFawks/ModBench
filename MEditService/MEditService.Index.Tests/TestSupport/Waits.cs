using System.Diagnostics;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>An arrival runs on a thread of its own, so a test asserting its outcome waits for what
/// the arrival announces rather than for a call to return.</summary>
internal static class Waits
{
    internal static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    internal static Task<bool> Until(Func<bool> condition, TimeSpan? timeout = null) =>
        Task.Run(() => ReachedWithin(condition, timeout ?? TimeSpan.FromSeconds(10)));

    internal static void Reached(Func<bool> condition, string what)
    {
        if (!ReachedWithin(condition, Patience)) throw new TimeoutException($"Never reached {what}.");
    }

    internal static bool ReachedWithin(Func<bool> condition, TimeSpan timeout)
    {
        var elapsed = Stopwatch.StartNew();
        while (!condition())
        {
            if (elapsed.Elapsed > timeout) return false;
            Thread.Sleep(5);
        }
        return true;
    }

    internal static async Task<bool> CompletesWithin(Task task, TimeSpan timeout) =>
        await Task.WhenAny(task, Task.Delay(timeout)) == task;
}
