using MEditService.LoadOrder;

namespace MEditService.TestSupport;

/// <summary>A snapshot's entries as the plugins a load order value holds, registered exactly as Mod
/// Management sent them. A fixture whose game directory forces plugins builds those
/// <c>RegisteredPlugin.Forced(...)</c> rows by hand instead.</summary>
public static class SnapshotPlugins
{
    public static IReadOnlyList<RegisteredPlugin> Of(IReadOnlyList<LoadOrderEntry> entries) =>
        [.. entries.Select(entry => RegisteredPlugin.Of(entry))];
}
