namespace MEditService.TestSupport;

/// <summary>Skipped, not passed, on Windows: the test needs a POSIX file system: a file mode that makes a
/// read, write or delete fail, a FIFO, or two names differing only in case.</summary>
public sealed class PosixFactAttribute : FactAttribute
{
    public PosixFactAttribute()
    {
        if (OperatingSystem.IsWindows())
            Skip = "Needs POSIX file modes, a FIFO, or names differing only in case.";
    }
}
