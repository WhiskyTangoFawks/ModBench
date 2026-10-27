namespace MEditService.ModFolderAdapter;

internal sealed class ScratchFiles : IScratchFiles
{
    private readonly Lazy<DirectoryInfo> _folder = new(() => Directory.CreateTempSubdirectory("medit-scratch-"));

    public Func<Stream> Store(Stream content)
    {
        var path = Path.Combine(_folder.Value.FullName, Path.GetRandomFileName());
        using (var to = File.Create(path)) content.CopyTo(to);
        return () => File.OpenRead(path);
    }

    public void Dispose()
    {
        if (_folder.IsValueCreated) _folder.Value.Delete(recursive: true);
    }
}
