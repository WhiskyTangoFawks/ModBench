namespace MEditService.TestSupport;

public static class TempLeftover
{
    private const int NoSuchProcess = 2_000_000_000;

    public static string DeadWriters(string folder) => Hold(folder, NoSuchProcess);

    public static string RunningWriters(string folder) => Hold(folder, Environment.ProcessId);

    /// <summary>A leftover folder no delete can empty: its file is held open on Windows, its folder read-only elsewhere.
    /// Disposing releases it.</summary>
    public static IDisposable Undeletable(string folder)
    {
        var leftover = Directory.CreateDirectory(Path.Combine(folder, $".medit_tmp_{NoSuchProcess}_stuck")).FullName;
        var file = Path.Combine(leftover, "held.tmp");
        if (OperatingSystem.IsWindows()) return new FileStream(file, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        File.WriteAllText(file, "half");
        File.SetUnixFileMode(leftover, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        return new Release(leftover);
    }

    private static string Hold(string folder, int processId)
    {
        var path = Path.Combine(folder, $".medit_tmp_{processId}_leftover.tmp");
        File.WriteAllText(path, "half");
        return path;
    }

    private sealed class Release(string leftover) : IDisposable
    {
        public void Dispose()
        {
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(leftover, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }
}
