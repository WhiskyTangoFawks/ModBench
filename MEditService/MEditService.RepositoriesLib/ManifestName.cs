namespace MEditService.RepositoriesLib;

/// <summary>A manifest's file name: the folder it builds, then the JSON suffix.</summary>
public static class ManifestName
{
    private const string Suffix = ".manifest.json";

    /// <summary>The glob of every manifest's name.</summary>
    public const string Glob = "*" + Suffix;

    public static bool Is(string fileName) => fileName.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase);
}
