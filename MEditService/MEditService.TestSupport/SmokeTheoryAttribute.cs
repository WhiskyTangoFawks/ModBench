namespace MEditService.TestSupport;

/// <summary><see cref="SmokeFactAttribute"/> for a table. Skipped, its rows are never read, so a
/// machine without the data the rows name still runs.</summary>
public sealed class SmokeTheoryAttribute : TheoryAttribute
{
    public SmokeTheoryAttribute(string reason)
    {
        if (Environment.GetEnvironmentVariable("MEDIT_SMOKE") != "1")
            Skip = $"Set MEDIT_SMOKE=1 to {reason}.";
    }
}
