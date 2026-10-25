using System.Diagnostics;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>An arrival runs on a thread of its own, so a test asserting its outcome waits for what
/// the arrival announces rather than for a call to return.</summary>
internal static class Waits
{
    internal static readonly TimeSpan Patience = TimeSpan.FromMinutes(3);

    internal static Task<bool> Until(Func<bool> condition) =>
        Task.Run(() => ReachedWithin(condition, TimeSpan.FromSeconds(10)));

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

    internal static async Task AdvancingUntil(this FakeTimeProvider clock, Task task, TimeSpan step)
    {
        var elapsed = Stopwatch.StartNew();
        while (!await CompletesWithin(task, TimeSpan.FromMilliseconds(50)))
        {
            if (elapsed.Elapsed > Patience) throw new TimeoutException("Never completed while the clock advanced.");
            clock.Advance(step);
        }
    }

    internal static async Task<bool> EverSeenWhile(Func<bool> seen, Action act)
    {
        var stopped = false;
        var reader = Task.Run(() =>
        {
            var ever = false;
            while (!Volatile.Read(ref stopped)) ever |= seen();
            return ever;
        });
        try
        {
            act();
        }
        finally
        {
            Volatile.Write(ref stopped, true);
        }
        return await reader;
    }
}
