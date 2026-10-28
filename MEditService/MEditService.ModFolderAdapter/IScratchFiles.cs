namespace MEditService.ModFolderAdapter;

public interface IScratchFiles : IDisposable
{
    /// <summary>Keeps <paramref name="content"/>; the function opens a copy to read from the start.</summary>
    Func<Stream> Store(Stream content);
}
