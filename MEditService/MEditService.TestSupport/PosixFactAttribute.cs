namespace MEditService.TestSupport;

/// <summary>Skipped, not passed, on Windows: the test makes a delete fail with a file mode, and
/// Windows has no handle a test can hold on a file the code under test has yet to create.</summary>
public sealed class PosixFactAttribute : FactAttribute
{
    public PosixFactAttribute()
    {
        if (OperatingSystem.IsWindows())
            Skip = "Makes a delete fail with a POSIX file mode.";
    }
}
