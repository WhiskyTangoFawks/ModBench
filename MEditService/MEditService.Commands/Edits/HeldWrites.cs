using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

internal static class HeldWrites
{
    /// <summary>Hands the record index <paramref name="written"/>, and returns once it holds it (ADR-0029); <paramref name="cancel"/>
    /// stops the wait, not the write. A write it could not read is answered as written, and logged.</summary>
    internal static async Task Held(this IQueries index, IReadOnlyList<HandedPlugin>? written, ILogger logger, CancellationToken cancel)
    {
        if (written is { Count: 0 }) return;
        if (await index.Hold(written, cancel).ConfigureAwait(false) is { } unread)
            logger.LogWarning("A write landed that the record index has not read: {Message}", unread);
    }

    /// <summary>As <see cref="Held"/>, for a write that cannot know its rows, so each plugin is read back whole.</summary>
    internal static Task ReadBack(this IQueries index, IEnumerable<PluginAddress> written, ILogger logger, CancellationToken cancel) =>
        index.Held([.. written.Distinct(PluginAddress.Comparer).Select(HandedPlugin.ReadBack)], logger, cancel);
}
