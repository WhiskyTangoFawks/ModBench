using System.Diagnostics;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>A budget is the time a gesture should take. A run fails only past three times it, so a slow machine is
/// not a regression while a cost that grows with the load order is.</summary>
internal static class Budgets
{
    private const int Tolerance = 3;

    internal static void Reached(TimeSpan budget, Func<bool> reached, string what) =>
        Assert.True(Waits.ReachedWithin(reached, budget * Tolerance), Over(budget, what));

    internal static void Ran(TimeSpan budget, Action gesture, string what)
    {
        var took = Stopwatch.StartNew();
        gesture();
        Assert.True(took.Elapsed <= budget * Tolerance, $"{Over(budget, what)} It took {took.Elapsed.TotalSeconds:F1} s.");
    }

    private static string Over(TimeSpan budget, string what) =>
        $"{what} ran past {(budget * Tolerance).TotalSeconds:F1} s, {Tolerance} times its budget of {budget.TotalSeconds:F1} s.";
}
