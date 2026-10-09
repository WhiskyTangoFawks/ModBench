namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>Skipped, not passed, on Windows: its file system cannot hold two names differing only in case.</summary>
public sealed class CaseSensitiveFactAttribute : FactAttribute
{
    public CaseSensitiveFactAttribute()
    {
        if (OperatingSystem.IsWindows())
            Skip = "Needs two folders whose names differ only in case.";
    }
}
