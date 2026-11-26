using System.Diagnostics;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>An arrival runs on a thread of its own, so a test asserting its outcome waits for what
/// the arrival announces rather than for a call to return.</summary>
internal static class Waits
{
    internal static readonly TimeSpan Patience = TimeSpan.FromMinutes(3);

    internal static Task<bool> Until(Func<bool> condition) =>
        Task.Run(() => ReachedWithin(condition, TimeSpan.FromSeconds(10)));

    internal static void Reached(Func<bool> condition, string what, TimeSpan? patience = null)
    {
        if (!ReachedWithin(condition, patience ?? Patience)) throw new TimeoutException($"Never reached {what}.");
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

    internal static TimeSpan LongestReadUntil<T>(Func<T> read, Func<bool> reached) => LongestReadUntil(read, _ => reached());

    internal static TimeSpan LongestReadUntil<T>(Func<T> read, Func<T, bool> condition)
    {
        var longest = TimeSpan.Zero;
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed <= Patience)
        {
            var reading = Stopwatch.StartNew();
            var value = read();
            if (reading.Elapsed > longest) longest = reading.Elapsed;
            if (condition(value)) return longest;
        }
        throw new TimeoutException($"Never read a value the condition holds for; the longest read took {longest}.");
    }

    internal static async Task<bool> CompletesWithin(Task task, TimeSpan timeout) =>
        await Task.WhenAny(task, Task.Delay(timeout)) == task;

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
