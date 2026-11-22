namespace MEditService.Commands.Tests.TestSupport;

/// <summary>What a write's answer names: each path it wrote, or a folder that holds it, and nothing outside the folders it wrote in or made.</summary>
internal static class WrittenPaths
{
    internal static void Cover(IReadOnlyList<string> written, params string[] paths)
    {
        foreach (var path in paths.Select(Path.GetFullPath))
            Assert.True(written.Any(named => path == named || Below(path, named)), $"{path} is not named by: {string.Join(", ", written)}");
    }

    internal static void Within(IReadOnlyList<string> written, params string[] folders)
    {
        foreach (var named in written)
            Assert.True(folders.Select(Path.GetFullPath).Any(folder => named == folder || Below(named, folder)), $"{named} lies outside {string.Join(", ", folders)}");
    }

    private static bool Below(string path, string folder) => path.StartsWith(folder + Path.DirectorySeparatorChar, StringComparison.Ordinal);
}
