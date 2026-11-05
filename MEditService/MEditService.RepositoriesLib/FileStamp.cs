namespace MEditService.RepositoriesLib;

/// <summary>What the file system says of a file without a read of its bytes: its size and date
/// modified, which a link leaves as it was (ADR-0003). The date is ticks since the Unix epoch.</summary>
internal readonly record struct FileStamp(long Size, long Modified)
{
    /// <summary>Null when the file system cannot answer, and then nothing vouches for a remembered
    /// hash.</summary>
    internal static FileStamp? Of(string path)
    {
        try
        {
            var file = new FileInfo(path);
            return file.Exists
                ? new FileStamp(file.Length, (file.LastWriteTimeUtc - DateTime.UnixEpoch).Ticks)
                : null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    // A file system stamps a change with a clock coarser than a read is quick, and a network share's
    // clock is not this machine's: a stamp this recent may not change for a write that follows it.
    private const int SettledAfterSeconds = 2;

    /// <summary>True once the file's date modified is old enough that a later write would move the stamp.</summary>
    internal bool SettledAt(DateTimeOffset moment) =>
        Modified < (moment.AddSeconds(-SettledAfterSeconds) - DateTimeOffset.UnixEpoch).Ticks;
}
