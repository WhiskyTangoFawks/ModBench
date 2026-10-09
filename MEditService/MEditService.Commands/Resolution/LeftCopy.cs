using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Resolution;

/// <summary>What the walk to the left found: a copy, none, or something it could not read.</summary>
internal abstract record LeftCopy
{
    private LeftCopy()
    {
    }

    internal sealed record Found(string Text, PluginAddress Plugin) : LeftCopy;

    internal sealed record None : LeftCopy;

    internal abstract record Unreadable(PluginAddress Plugin, string Why, RecordEditRefusal Kind = RecordEditRefusal.RecordParseFailed) : LeftCopy
    {
        protected abstract string Unread { get; }

        /// <summary>The refusal of a write that <paramref name="needs"/> this copy.</summary>
        internal RecordEditResult Refusal(string spelled, string needs) =>
            RecordEditResult.RefusedAt(
                Kind, spelled,
                $"'{spelled}': {needs}, and {Unread} cannot be read: {Why.TrimEnd('.')}. Nothing was written.");
    }

    /// <summary>A plugin's copy of <paramref name="Asked"/> (a FormKey or a worldspace).</summary>
    internal sealed record UnreadableCopy(PluginAddress Plugin, string Asked, string Why) : Unreadable(Plugin, Why)
    {
        protected override string Unread => $"{Plugin.Name}'s copy of {Asked}";
    }

    internal sealed record UnreadableMastersTree(PluginAddress Plugin, string Why, RecordEditRefusal Kind) : Unreadable(Plugin, Why, Kind)
    {
        protected override string Unread => $"the source tree that names {Plugin.Name}'s masters";
    }

    internal string? FoundText => (this as Found)?.Text;
}
