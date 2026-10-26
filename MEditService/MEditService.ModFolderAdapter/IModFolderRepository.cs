using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

/// <summary>The one reader of a mod folder's files and the one writer of a mod's manifest.</summary>
public interface IModFolderRepository
{
    /// <summary>Every file of the mod but its manifest and those left out, by forward-slash path. A file whose stamp the
    /// stat cache in <paramref name="statCache"/> last read goes unread; with none, every file is read.</summary>
    ModFolderFiles Files(string modFolder, string modName, IReadOnlySet<string> leftOut, string? statCache);

    /// <summary>Keeps in the stat cache what <paramref name="read"/> found, and as the hash each line's package fixes,
    /// the one <paramref name="hashes"/> holds for its path. Why it could not, or null.</summary>
    string? KeepInStatCache(ModFolderFiles read, Manifest manifest, IReadOnlyDictionary<string, string> hashes);

    /// <summary>Every file of the mod no line of <paramref name="manifest"/> names, but its manifest and those left out. A
    /// line names a file in another case where the file system finds it by the line's name.</summary>
    IReadOnlyList<string> NamedByNoLine(string modFolder, string modName, Manifest manifest, IReadOnlySet<string> leftOut);

    /// <summary>The mod's folder against its manifest, a source mod's in <paramref name="sourceFolder"/>, from each file's
    /// stamp, the stat cache, which keeps what it read, and the metadata the mod manager <paramref name="held"/>.</summary>
    ModStatus Status(string modFolder, string modName, IReadOnlySet<string> leftOut, string statCache, ModMetadata? held, string? sourceFolder);

    Stream OpenFile(string modFolder, string path);

    bool InstallationFileExists(string path);

    /// <summary>The name of the installation file at <paramref name="path"/>, without its folder.</summary>
    string InstallationFileName(string path);

    /// <summary>Every file's forward-slash path in <paramref name="modFolder"/>; none when it is not there.</summary>
    IReadOnlyList<string> FilePaths(string modFolder);

    /// <summary>The name of the mod folder at <paramref name="modFolder"/>, without the folder it is in.</summary>
    string FolderName(string modFolder);

    /// <summary>The forward-slash path relative to <paramref name="modFolder"/> of the file at <paramref name="file"/>.</summary>
    string PathIn(string modFolder, string file);

    /// <summary>Writes the file at <paramref name="path"/> under <paramref name="folder"/> from <paramref name="write"/>'s
    /// seekable stream. A throwing write, or the bytes already there, leave the folder as it was. True when it replaced
    /// other bytes.</summary>
    bool WriteFile(string folder, string path, Action<Stream> write);

    bool DataFolderExists(string dataFolder);

    /// <summary>The name the mod manager gives a file or folder that a build leaves out.</summary>
    string ExcludedName(string name, string exclusionMark);

    Stream OpenInstallationFile(string path);

    /// <summary>The game file at the forward-slash <paramref name="path"/> under the game's <paramref name="dataFolder"/>.</summary>
    Stream OpenGameFile(string dataFolder, string path);

    /// <summary>Writes the mod's manifest into its folder, and only when its text differs from the one there.
    /// True when it wrote.</summary>
    bool WriteManifest(string modFolder, string modName, Manifest manifest);

    /// <summary>Deletes the manifest in the mod's folder, as the source mod's repository in <paramref name="sourceFolder"/>
    /// holds its manifest instead, and answers what it deleted. A repository in the mod's folder keeps its own.</summary>
    SpelledManifest? RemoveManifest(string modFolder, string modName, string sourceFolder);

    /// <summary>The mod's manifest; null when its folder holds none. Throws
    /// <see cref="InvalidDataException"/> naming a line it cannot read.</summary>
    Manifest? ReadManifest(string modFolder, string modName);

    /// <summary>The manifest at the root of the source mod's repository in <paramref name="sourceFolder"/>, null when there is
    /// none, or why it cannot be read.</summary>
    Answer<Manifest?, string> ReadSourceManifest(string sourceFolder);

    /// <summary>Writes the manifest at the root of the source mod's repository in <paramref name="sourceFolder"/>, named for
    /// its output folder, in place of the one there, and only when its text differs. True when it wrote.</summary>
    bool WriteSourceManifest(string sourceFolder, Manifest manifest);

    /// <summary>The name and the bytes <see cref="WriteSourceManifest"/> writes.</summary>
    SpelledManifest SpellSourceManifest(Manifest manifest);
}
