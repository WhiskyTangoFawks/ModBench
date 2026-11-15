using System.Diagnostics;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>A budget is the time a gesture should take. A run fails only past three times it, so a slow machine is
/// not a regression while a cost that grows with the load order is.</summary>
internal static class Budgets
{
    private const int Tolerance = 3;

    internal static void Reached(TimeSpan budget, Func<bool> reached, string what)
    {
        var took = Stopwatch.StartNew();
        Assert.True(Waits.ReachedWithin(reached, budget * Tolerance), Over(budget, what));
        Console.WriteLine($"BUDGET {what}: {took.Elapsed.TotalSeconds:F2} s");
    }

    /// <summary>Runs the gesture once, or after one warm-up <paramref name="runs"/> times and holds the fastest to the
    /// budget: load from other processes only slows a run, so the minimum is nearest the code's own cost.</summary>
    internal static void Ran(TimeSpan budget, Action gesture, string what, int runs = 1)
    {
        if (runs > 1) gesture();
        var fastest = Enumerable.Range(0, runs).Min(_ =>
        {
            var took = Stopwatch.StartNew();
            gesture();
            return took.Elapsed;
        });
        Assert.True(fastest <= budget * Tolerance, $"{Over(budget, what)} It took {fastest.TotalSeconds:F1} s.");
        Console.WriteLine($"BUDGET {what}: {fastest.TotalSeconds:F2} s");
    }

    private static string Over(TimeSpan budget, string what) =>
        $"{what} ran past {(budget * Tolerance).TotalSeconds:F1} s, {Tolerance} times its budget of {budget.TotalSeconds:F1} s.";
}
