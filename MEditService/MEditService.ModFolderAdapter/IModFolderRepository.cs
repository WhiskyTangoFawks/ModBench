namespace MEditService.ModFolderAdapter;

/// <summary>The one reader and writer of the assets and archives of a source mod's output folder.</summary>
public interface IModFolderRepository
{
    Stream OpenFile(string modFolder, string path);

    /// <summary>Every file's forward-slash path in <paramref name="modFolder"/>; none when it is not there.</summary>
    IReadOnlyList<string> FilePaths(string modFolder);

    /// <summary>Writes the file at <paramref name="path"/> under <paramref name="folder"/> from <paramref name="write"/>'s
    /// seekable stream. A throwing write, or the bytes already there, leave the folder as it was.</summary>
    void WriteFile(string folder, string path, Action<Stream> write);

    bool DataFolderExists(string dataFolder);

    /// <summary>The name the mod manager gives a file or folder that a build leaves out.</summary>
    string ExcludedName(string name, string exclusionMark);
}
