namespace MEditService.RepositoriesLib;

public static class FilePaths
{
    // Windows names a file without regard to case, and VS Code spells a drive letter in lower case.
    public static StringComparison Comparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
}
