using System.IO.Compression;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>A mod installed from the download <c>Mod.zip</c>, which holds <c>kept.txt</c> and <c>edited.txt</c>.</summary>
internal static class DownloadedMod
{
    internal const string HashOfKept = "gO3vE0ddOto=";
    internal const string HashOfOriginal = "PclCUmd0Z4s=";
    internal const string HashOfTheZip = "AAECAwQFBgc=";

    /// <summary>What the download holds as <c>edited.txt</c>.</summary>
    internal static string Original => string.Concat(Enumerable.Range(0, 1000).Select(line => $"{line:D7}\n"));

    /// <summary>The mod in <paramref name="modFolder"/> and its download in <paramref name="downloads"/>, with
    /// <c>edited.txt</c> holding <paramref name="edited"/>, or what the download holds.</summary>
    internal static void Install(string modFolder, string downloads, string? edited = null)
    {
        Directory.CreateDirectory(modFolder);
        File.WriteAllText(Path.Combine(modFolder, "kept.txt"), "kept");
        File.WriteAllText(Path.Combine(modFolder, "edited.txt"), edited ?? Original);
        Directory.CreateDirectory(downloads);
        using var zip = ZipFile.Open(Path.Combine(downloads, "Mod.zip"), ZipArchiveMode.Create);
        foreach (var (entry, content) in new[] { ("kept.txt", "kept"), ("edited.txt", Original) })
        {
            using var writer = new StreamWriter(zip.CreateEntry(entry).Open());
            writer.Write(content);
        }
    }
}
