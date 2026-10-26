namespace MEditService.RepositoriesLib;

/// <summary>A manifest's file name and its bytes.</summary>
public sealed record SpelledManifest(string Name, byte[] Text);
