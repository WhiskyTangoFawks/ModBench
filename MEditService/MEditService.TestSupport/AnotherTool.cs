namespace MEditService.TestSupport;

public static class AnotherTool
{
    // Windows refuses to delete the read-only files git writes; a tool that removes a repository clears them first.
    public static void Delete(string folder)
    {
        foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(folder, recursive: true);
    }

    /// <summary>A path relative to <paramref name="document"/>'s folder, <c>{0}</c> standing for its file name, with the
    /// folders it needs made.</summary>
    public static string Beside(string document, string relativeTarget)
    {
        var target = Path.Combine(
            Path.GetDirectoryName(document).Require(),
            string.Format(System.Globalization.CultureInfo.InvariantCulture, relativeTarget, Path.GetFileName(document)));
        Directory.CreateDirectory(Path.GetDirectoryName(target).Require());
        return target;
    }
}
