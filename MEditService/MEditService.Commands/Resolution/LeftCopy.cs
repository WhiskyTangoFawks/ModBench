using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Resolution;

/// <summary>What the walk to the left found: a copy, none, or <see cref="Unreadable.What"/> it could not
/// read on the way: the nearest copy, or the source tree that names the masters it walks.</summary>
internal abstract record LeftCopy
{
    private LeftCopy()
    {
    }

    internal sealed record Found(string Text, PluginAddress Plugin) : LeftCopy;

    internal sealed record None : LeftCopy;

    internal sealed record Unreadable(string What, string Why) : LeftCopy
    {
        /// <summary>The refusal of a write that <paramref name="needs"/> this copy.</summary>
        internal RecordEditResult Refusal(string spelled, string needs) =>
            RecordEditResult.RefusedAt(
                RecordEditRefusal.RecordParseFailed, spelled,
                $"'{spelled}': {needs}, and {What} cannot be read: {Why.TrimEnd('.')}. Nothing was written.");
    }

    internal string? FoundText => (this as Found)?.Text;
}
