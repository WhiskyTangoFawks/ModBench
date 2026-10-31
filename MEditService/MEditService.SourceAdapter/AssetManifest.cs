using System.Text;
using System.Text.Json;

namespace MEditService.SourceAdapter;

/// <summary>A manifest whose paths are the mod folder's, placed where the source folder holds each file as an asset.
/// Prefixing every path alike keeps the manifest's canonical order and layout.</summary>
internal static class AssetManifest
{
    private static readonly string[] PathSections = ["\"exclude\":[", "\"files\":{"];

    /// <summary>The paths of a manifest's files, as it names them.</summary>
    internal static IEnumerable<string> PathsOf(byte[] manifest)
    {
        var inFiles = false;
        foreach (var line in Encoding.UTF8.GetString(manifest).Split('\n'))
        {
            if (line == "\"files\":{") inFiles = true;
            else if (line == "}") inFiles = false;
            else if (inFiles && line.StartsWith('"'))
            {
                using var entry = JsonDocument.Parse("{" + line.TrimEnd(',') + "}");
                yield return entry.RootElement.EnumerateObject().First().Name;
            }
        }
    }

    internal static byte[] Placed(byte[] manifest)
    {
        var inPaths = false;
        var lines = Encoding.UTF8.GetString(manifest).Split('\n').Select(line =>
        {
            if (PathSections.Contains(line)) inPaths = true;
            else if (line is "]" or "}") inPaths = false;
            else if (inPaths && line.StartsWith('"')) return $"\"{SourceRepositoryLayout.AssetsFolderName}/{line[1..]}";
            return line;
        }).ToList();
        return new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(string.Join('\n', lines));
    }
}
