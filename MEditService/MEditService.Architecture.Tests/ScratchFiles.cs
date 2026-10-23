using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

/// <summary>Source files planted in a scratch directory, for the tests that prove a scan names what it should.</summary>
internal static class ScratchFiles
{
    internal static void Plant(string root, string relativePath, string text)
    {
        var path = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        File.WriteAllText(path, text);
    }
}
