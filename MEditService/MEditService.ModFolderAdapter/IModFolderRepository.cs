namespace MEditService.ModFolderAdapter;

/// <summary>The one reader and writer of the assets and archives of a source mod's output folder.</summary>
public interface IModFolderRepository
{
    /// <summary>Each file's hash in <paramref name="modFolder"/>, by its forward-slash path, read now.</summary>
    IReadOnlyDictionary<string, string> Hashes(string modFolder);

    Stream OpenFile(string modFolder, string path);

    /// <summary>Every file's forward-slash path in <paramref name="modFolder"/>; none when it is not there.</summary>
    IReadOnlyList<string> FilePaths(string modFolder);

    /// <summary>The forward-slash path relative to <paramref name="modFolder"/> of the file at <paramref name="file"/>.</summary>
    string PathIn(string modFolder, string file);

    /// <summary>Writes the file at <paramref name="path"/> under <paramref name="folder"/> from <paramref name="write"/>'s
    /// seekable stream. A throwing write, or the bytes already there, leave the folder as it was. True when it replaced
    /// other bytes.</summary>
    bool WriteFile(string folder, string path, Action<Stream> write);

    /// <summary>Deletes the file at <paramref name="path"/> under <paramref name="folder"/>; one already gone is done.</summary>
    void DeleteFile(string folder, string path);

    bool DataFolderExists(string dataFolder);

    /// <summary>The name the mod manager gives a file or folder that a build leaves out.</summary>
    string ExcludedName(string name, string exclusionMark);
}
