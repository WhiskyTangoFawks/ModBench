using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Resolution;

/// <summary>What the walk to the left found: a copy, none, or what it could not
/// read on the way: a plugin's copy of what was asked about, or, with no <see cref="Unreadable.Asked"/>, the
/// source tree of the plugin that names the masters it walks.</summary>
internal abstract record LeftCopy
{
    private LeftCopy()
    {
    }

    internal sealed record Found(string Text, PluginAddress Plugin) : LeftCopy;

    internal sealed record None : LeftCopy;

    internal sealed record Unreadable(PluginAddress Plugin, string? Asked, string Why) : LeftCopy
    {
        private string Unread => Asked is null ? $"the source tree that names {Plugin.Name}'s masters" : $"{Plugin.Name}'s copy of {Asked}";

        /// <summary>The refusal of a write that <paramref name="needs"/> this copy.</summary>
        internal RecordEditResult Refusal(string spelled, string needs) =>
            RecordEditResult.RefusedAt(
                RecordEditRefusal.RecordParseFailed, spelled,
                $"'{spelled}': {needs}, and {Unread} cannot be read: {Why.TrimEnd('.')}. Nothing was written.");
    }

    internal string? FoundText => (this as Found)?.Text;
}
