namespace MEditService.LoadOrder;

/// <summary>Where a new plugin can live: an enabled mod or Overwrite, by origin, at its folder and, for a source mod,
/// its source folder.</summary>
public sealed record PluginPlace(string Name, string Folder, string? SourceFolder);
