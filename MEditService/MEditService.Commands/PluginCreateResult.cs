using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>What the create gesture landed: the copy it wrote and registered, the version of the
/// load order change registering it, and the Track it ran for an untracked destination — null
/// when a repository was already there.</summary>
public sealed record PluginCreateResult(RegisteredCopy Copy, long Version, TrackResult? Track)
{
    /// <summary>The file is written before Track runs, so only Track can refuse: an already-tracked
    /// destination has nothing left to land.</summary>
    public bool Applied => Track?.Applied ?? true;
}
