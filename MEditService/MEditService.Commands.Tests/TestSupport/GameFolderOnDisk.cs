using System.Text;
using MEditService.Commands.Build;
using MEditService.ModFolderAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A game folder written under a scratch folder with its files hashed, and the source manifest that takes
/// textures/a.dds from it.</summary>
internal static class GameFolderOnDisk
{
    public static GameFolder Holding(string root, string place, params (string Path, string Text)[] files)
    {
        var data = Directory.CreateDirectory(Path.Combine(root, "game", place, "Data")).FullName;
        foreach (var (path, text) in files)
        {
            var file = Path.Combine(data, path);
            Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
            File.WriteAllBytes(file, Encoding.UTF8.GetBytes(text));
        }
        var hashes = new ModFolderRepository(TimeProvider.System).Files(data, new HashSet<string>(), null).Files;
        return new GameFolder("Fallout 4", data, [.. hashes.Select(file => new GameFile(file.Path, file.Hash))]);
    }

    public static string ManifestTakingATextureFrom(GameFolder pinned) =>
        "{\"output\": \"Mod\", \"packages\": [{\"gameFolder\":\"Fallout 4\",\"hash\":\""
        + FileHash.OfFilesTaken([.. pinned.Files.Select(file => new HashedFile(file.Path, file.Hash))])
        + "\"}], \"files\": [{\"path\":\"textures/a.dds\"}]}";
}
