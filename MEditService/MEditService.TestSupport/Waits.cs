using System.Diagnostics;

namespace MEditService.TestSupport;

/// <summary>A test waits on a value, never on real time: work on a thread of its own is done when the
/// value it announces holds. A patience bounds a wait only so a broken test fails, so no wait here answers
/// false: a window a test waits out is a Task.Delay or Thread.Sleep, where check_test_waits.py names it.</summary>
public static class Waits
{
    public static readonly TimeSpan Patience = TimeSpan.FromMinutes(3);
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(5);

    public static void Reached(Func<bool> condition, string what, TimeSpan? patience = null)
    {
        var elapsed = Stopwatch.StartNew();
        while (!condition())
        {
            if (elapsed.Elapsed > (patience ?? Patience)) throw new TimeoutException($"Never reached {what}.");
            Thread.Sleep(PollInterval);
        }
    }

    public static TimeSpan LongestReadUntil<T>(Func<T> read, Func<bool> reached) => LongestReadUntil(read, _ => reached());

    public static TimeSpan LongestReadUntil<T>(Func<T> read, Func<T, bool> condition)
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

    public static async Task ReachedAsync(Func<Task<bool>> condition, string what, TimeSpan? patience = null)
    {
        var elapsed = Stopwatch.StartNew();
        while (!await condition())
        {
            if (elapsed.Elapsed > (patience ?? Patience)) throw new TimeoutException($"Never reached {what}.");
            await Task.Delay(PollInterval);
        }
    }

    public static async Task<bool> EverSeenWhile(Func<bool> seen, Action act)
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
