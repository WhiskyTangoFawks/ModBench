namespace MEditService.TestSupport.TestSupport;

/// <summary>The checkout's own root, walked up from the test output directory: every project's
/// architecture-style scan starts here.</summary>
public static class RepoRoot
{
    public static string SolutionDirectory()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "MEditService.sln")))
            dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("MEditService.sln not found above the test output directory.");
    }
}
