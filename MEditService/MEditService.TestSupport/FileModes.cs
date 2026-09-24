namespace MEditService.TestSupport;

/// <summary>Process-shelled because File.SetUnixFileMode is flagged platform-unsafe (CA1416) even on a
/// Linux-only runtime, and suppressing an analyzer warning is not a test's call to make.</summary>
public static class FileModes
{
    /// <summary>chmod <paramref name="mode"/> on <paramref name="path"/> alone, never recursively.</summary>
    public static void Set(string path, string mode)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "chmod", [mode, path])
        { RedirectStandardError = true }).Require();
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"chmod {mode} {path} failed: {process.StandardError.ReadToEnd()}");
    }
}
