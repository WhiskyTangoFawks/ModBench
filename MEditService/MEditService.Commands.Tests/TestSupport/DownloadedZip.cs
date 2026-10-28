using System.IO.Compression;
using System.Text;
using MEditService.Commands.Build;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A downloaded zip, and the source mod manifest that takes two files from it.</summary>
internal static class DownloadedZip
{
    public const string PackName = "Pack.zip";

    public const string PackHash = "HASH";

    /// <summary>A manifest for output Mod whose first package is <see cref="PackName"/>: it takes textures/a.dds from it, and
    /// meshes/c.nif from its Data/c.nif.</summary>
    public const string TakingFromAPack =
        "{\"output\": \"Mod\", \"packages\": [{\"installationFile\":\"Pack.zip\",\"size\":1,\"hash\":\"HASH\"}], "
        + "\"files\": [{\"path\":\"textures/a.dds\"}, {\"path\":\"meshes/c.nif\",\"packagePath\":\"Data/c.nif\"}]}";

    public static byte[] Bytes(params (string Path, byte[] Bytes)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, bytes) in entries)
            {
                using var entry = archive.CreateEntry(path).Open();
                entry.Write(bytes);
            }
        }
        return buffer.ToArray();
    }

    public static byte[] Bytes(params (string Path, string Text)[] entries) =>
        Bytes([.. entries.Select(entry => (entry.Path, Encoding.UTF8.GetBytes(entry.Text)))]);

    /// <summary>The zip written to <paramref name="downloads"/> as <see cref="PackName"/>, as the downloads folder holds it.</summary>
    public static InstallationFile WritePack(string downloads, params (string Path, string Text)[] entries)
    {
        Directory.CreateDirectory(downloads);
        var path = Path.Combine(downloads, PackName);
        File.WriteAllBytes(path, Bytes(entries));
        return new InstallationFile(path, Page: null, new FileInfo(path).Length, PackHash, [.. entries.Select(entry => new HashedEntry(entry.Path, entry.Text))]);
    }
}
