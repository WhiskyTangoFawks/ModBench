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
}
