using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A writer hands the record index its write and returns once it holds it (ADR-0029). The token stops the wait,
/// never the write. A write the record index could not read is answered as written, and logged.</summary>
internal sealed class HeldWrites(IQueries index, ILogger<HeldWrites> logger)
{
    internal async Task Hand(IReadOnlyList<HandedPlugin>? written, CancellationToken cancel)
    {
        if (written is { Count: 0 }) return;
        if (await index.Hold(written, cancel).ConfigureAwait(false) is { } unread)
            logger.LogWarning("A write landed that the record index has not read: {Message}", unread);
    }

    /// <summary>The plugins whose files, and those whose sources, a write cannot know the rows of, each read back whole.</summary>
    internal Task ReadBack(IEnumerable<PluginAddress> files, IEnumerable<PluginAddress> sources, CancellationToken cancel) =>
        Hand([
            .. files.Distinct(PluginAddress.Comparer).Select(HandedPlugin.ReadBack),
            .. sources.Distinct(PluginAddress.Comparer).Select(HandedPlugin.ReadBackSource)], cancel);

    internal Task ReadBack(IEnumerable<PluginAddress> files, CancellationToken cancel) => ReadBack(files, [], cancel);

    internal Task ReadBackSource(IEnumerable<PluginAddress> sources, CancellationToken cancel) => ReadBack([], sources, cancel);
}
