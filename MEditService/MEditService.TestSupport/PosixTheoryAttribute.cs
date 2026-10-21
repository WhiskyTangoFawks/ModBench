namespace MEditService.TestSupport;

/// <summary><see cref="PosixFactAttribute"/> for a test with data rows.</summary>
public sealed class PosixTheoryAttribute : TheoryAttribute
{
    public PosixTheoryAttribute()
    {
        if (OperatingSystem.IsWindows())
            Skip = "Needs POSIX file modes, a FIFO, or names differing only in case.";
    }
}
