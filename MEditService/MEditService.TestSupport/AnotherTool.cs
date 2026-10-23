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

    /// <summary>Every file under <paramref name="directory"/>, at the same depth under <paramref name="copiedTo"/>, a
    /// path relative to the directory's folder.</summary>
    public static void CopyDirectory(string directory, string copiedTo)
    {
        var target = Beside(directory, copiedTo);
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            var copy = Path.Combine(target, Path.GetRelativePath(directory, file));
            Directory.CreateDirectory(Path.GetDirectoryName(copy).Require());
            File.Copy(file, copy);
        }
    }
}
