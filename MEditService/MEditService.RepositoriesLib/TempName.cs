using System.Diagnostics;

namespace MEditService.RepositoriesLib;

/// <summary>The name of a file or folder a write is held in until renamed into place. It carries the writing
/// process id, so a leftover is a temp whose writer has exited.</summary>
public static class TempName
{
    private const string Prefix = ".medit_tmp_";

    public static string FileIn(string folder) => Combine(folder) + ".tmp";

    public static string FolderIn(string folder) => Combine(folder);

    private static bool IsTemp(string name) => name.StartsWith(Prefix, StringComparison.Ordinal);

    public static bool HoldsTemp(string forwardSlashPath) => forwardSlashPath.Split('/').Any(IsTemp);

    /// <summary>Deletes the temps in <paramref name="folder"/> whose writer is gone. A delete that fails throws, as a
    /// write into the folder would.</summary>
    public static void RemoveLeftovers(string folder)
    {
        if (!Directory.Exists(folder)) return;
        foreach (var entry in new DirectoryInfo(folder).EnumerateFileSystemInfos().Where(entry => IsTemp(entry.Name) && !WriterRuns(entry.Name)).ToList())
        {
            if (entry is DirectoryInfo directory) directory.Delete(recursive: true);
            else entry.Delete();
        }
    }

    private static string Combine(string folder) =>
        Path.Combine(folder, $"{Prefix}{Environment.ProcessId}_{Path.GetRandomFileName()}");

    // A name that does not carry a process id has no writer to prove gone, so it stays.
    private static bool WriterRuns(string name)
    {
        var id = name[Prefix.Length..].Split('_')[0];
        if (!int.TryParse(id, out var processId)) return true;
        try
        {
            using var process = Process.GetProcessById(processId);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
