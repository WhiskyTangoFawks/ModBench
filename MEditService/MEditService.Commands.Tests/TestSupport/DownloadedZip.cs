using System.IO.Compression;
using System.Text;
using MEditService.Commands.Build;
using MEditService.ModFolderAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A zip of the entries at <c>path</c>, each entry hashed as a mod's file is, extracted first under
/// <c>scratch</c>. Its own hash is a placeholder: no test here reads it from the bytes.</summary>
internal static class DownloadedZip
{
    public static InstallationFile At(string path, string scratch, params (string Path, string Text)[] entries)
    {
        var extracted = Directory.CreateDirectory(Path.Combine(scratch, "extracted")).FullName;
        foreach (var (entry, text) in entries)
        {
            var file = Path.Combine(extracted, entry);
            Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
            File.WriteAllBytes(file, Encoding.UTF8.GetBytes(text));
        }
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        ZipFile.CreateFromDirectory(extracted, path);
        var hashed = new ModFolderRepository(TimeProvider.System).Files(extracted, "installed", new HashSet<string>(), statCache: null).Files;
        return new InstallationFile(
            path, Source: null, Size: new FileInfo(path).Length, Hash: "AAAAAAAAAAA=", [.. hashed.Select(entry => new HashedEntry(entry.Path, entry.Hash))]);
    }
}
