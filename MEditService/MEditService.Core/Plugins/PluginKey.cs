namespace MEditService.Core.Plugins;

/// <summary>Filename plus providing mod folder (ADR-0036): two loaded copies can share a filename.
/// A null <see cref="Origin"/> matches no row where a key names one; in a filter position it means
/// any origin.</summary>
public readonly record struct PluginKey(string Name, string? Origin = null)
{
    public static implicit operator PluginKey(string name) => new(name);
}
