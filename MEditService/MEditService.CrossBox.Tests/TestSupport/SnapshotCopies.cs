using MEditService.LoadOrder;

namespace MEditService.Tests;

/// <summary>A snapshot's entries as the copies a load order value holds, registered exactly as Mod
/// Management sent them. A fixture whose game directory forces plugins composes them through the
/// API's deriver instead.</summary>
internal static class SnapshotCopies
{
    public static IReadOnlyList<RegisteredCopy> Of(IReadOnlyList<LoadOrderEntry> entries) =>
        [.. entries.Select(entry => RegisteredCopy.Of(entry))];
}
