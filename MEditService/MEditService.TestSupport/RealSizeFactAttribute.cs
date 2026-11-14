namespace MEditService.TestSupport;

/// <summary>Skipped without MEDIT_REAL_SIZE=1: building a <see cref="RealSizeModlist"/>'s index takes minutes, so the
/// gate of its own runs it.</summary>
public sealed class RealSizeFactAttribute : FactAttribute
{
    public RealSizeFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("MEDIT_REAL_SIZE") != "1")
            Skip = "Set MEDIT_REAL_SIZE=1 to build the record index of real size.";
    }
}
