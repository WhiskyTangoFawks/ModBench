namespace MEditService.PluginAdapter;

internal static class ScratchFolder
{
    /// <summary>Cleanup is a courtesy, never allowed to outrank the read or the exception it follows: a
    /// folder something else holds, such as a Windows virus scanner, stays on disk.</summary>
    internal static void DeleteAsCourtesy(string folder)
    {
        try { Directory.Delete(folder, recursive: true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return; }
    }
}
