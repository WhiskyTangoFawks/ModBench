using System.IO.Hashing;

namespace MEditService.ModFolderAdapter;

/// <summary>A file's hash, read to tell whether a build changed its bytes.</summary>
internal static class FileHash
{
    internal static string Of(Stream content)
    {
        var algorithm = new XxHash64();
        algorithm.Append(content);
        return Convert.ToBase64String(algorithm.GetCurrentHash());
    }
}
