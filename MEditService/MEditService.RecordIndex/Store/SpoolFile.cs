namespace MEditService.RecordIndex.Store;

/// <summary>The file one SELECT's rows are spooled to, beside the index file so it is disk on the index's volume. The
/// producer closes <see cref="Writer"/>; disposing this closes the reader and removes the file.</summary>
internal sealed class SpoolFile : IDisposable
{
    internal const string Extension = ".spool";

    private readonly Action _remove;

    internal SpoolFile(Stream writer, Stream reader, Action remove)
    {
        Writer = writer;
        Reader = reader;
        _remove = remove;
    }

    internal Stream Writer { get; }

    internal Stream Reader { get; }

    internal static SpoolFile In(string directory)
    {
        try
        {
            return Opened(directory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new IndexFaultException($"mEdit could not open a file to spool this SELECT's rows: {ex.Message}", ex) { Fault = IndexFault.Refused };
        }
    }

    private static SpoolFile Opened(string directory)
    {
        var path = Path.Combine(directory, $"{Guid.NewGuid():N}{Extension}");
        var windows = OperatingSystem.IsWindows();
        var writer = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete, 4096,
            windows ? FileOptions.DeleteOnClose : FileOptions.None);
        try
        {
            var reader = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (!windows) File.Delete(path);
            return new SpoolFile(writer, reader, () => File.Delete(path));
        }
        catch (IOException)
        {
            writer.Dispose();
            File.Delete(path);
            throw;
        }
    }

    /// <summary>Removes the spool files a killed process left in <paramref name="directory"/>.</summary>
    internal static void Sweep(string directory)
    {
        foreach (var path in Directory.EnumerateFiles(directory, $"*{Extension}")) File.Delete(path);
    }

    /// <summary>Closes the file of rows nothing will produce.</summary>
    internal void Abandon()
    {
        Writer.Dispose();
        Dispose();
    }

    public void Dispose()
    {
        Reader.Dispose();
        _remove();
    }
}
