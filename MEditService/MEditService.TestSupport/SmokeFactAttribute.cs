namespace MEditService.Tests.RealData;

/// <summary>Skipped, not passed, without MEDIT_SMOKE=1, so a run reports honestly rather than a
/// green no-op.</summary>
public sealed class SmokeFactAttribute : FactAttribute
{
    public SmokeFactAttribute(string reason)
    {
        if (Environment.GetEnvironmentVariable("MEDIT_SMOKE") != "1")
            Skip = $"Set MEDIT_SMOKE=1 to {reason}.";
    }
}
