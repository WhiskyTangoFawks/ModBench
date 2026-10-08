using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Resolution;

/// <summary>What the walk to the left found: a copy, none, or a nearest copy it cannot read.</summary>
internal abstract record LeftCopy
{
    private LeftCopy()
    {
    }

    internal sealed record Found(string Text, PluginAddress Plugin) : LeftCopy;

    internal sealed record None : LeftCopy;

    internal sealed record Unreadable(string Plugin, string FormKey, string Why) : LeftCopy
    {
        /// <summary>The refusal of a write that <paramref name="needs"/> this copy.</summary>
        internal RecordEditResult Refusal(string spelled, string needs) =>
            RecordEditResult.RefusedAt(
                RecordEditRefusal.RecordParseFailed, spelled,
                $"'{spelled}': {needs}, and {Plugin}'s copy of {FormKey} cannot be read: {Why.TrimEnd('.')}. Nothing was written.");
    }

    internal string? FoundText => (this as Found)?.Text;
}
