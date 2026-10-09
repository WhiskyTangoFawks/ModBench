namespace MEditService.TestSupport;

/// <summary>Skipped, not passed, on Windows: the test needs a POSIX file system, either a file mode that makes a
/// read or delete fail, or two names differing only in case.</summary>
public sealed class PosixFactAttribute : FactAttribute
{
    public PosixFactAttribute()
    {
        if (OperatingSystem.IsWindows())
            Skip = "Needs POSIX file modes or names differing only in case.";
    }
}
