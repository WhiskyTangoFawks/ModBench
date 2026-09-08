using MEditService.Core.Source;

namespace MEditService.Core.Plugins;

/// <summary>What the create gesture landed: the copy it registered, and the Track it ran when the
/// destination held no repository yet — null when one was already there.</summary>
public sealed record PluginCreateResult(RegisteredCopy Copy, TrackResult? Track)
{
    /// <summary>The file is written and registered before Track runs, so only Track can refuse: an
    /// already-tracked destination has nothing left to land.</summary>
    public bool Applied => Track?.Applied ?? true;
}
