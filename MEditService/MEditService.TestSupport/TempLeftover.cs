namespace MEditService.TestSupport;

public static class TempLeftover
{
    private const int NoSuchProcess = 2_000_000_000;

    public static string DeadWriters(string folder) => Hold(folder, NoSuchProcess);

    public static string RunningWriters(string folder) => Hold(folder, Environment.ProcessId);

    /// <summary>The file or folder at <paramref name="path"/> as a later process finds it once this one exits: a name that
    /// carries this process's id carries a dead one. Answers where it now is.</summary>
    public static string AsIfItsWriterExited(string path)
    {
        var name = Path.GetFileName(path);
        var dead = name.Replace($"_{Environment.ProcessId}_", $"_{NoSuchProcess}_", StringComparison.Ordinal);
        if (dead == name) return path;
        var moved = Path.Combine(Path.GetDirectoryName(path) ?? "", dead);
        Directory.Move(path, moved);
        return moved;
    }

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
