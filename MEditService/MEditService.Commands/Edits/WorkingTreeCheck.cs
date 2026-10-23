using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Edits;

/// <summary>Why a gesture that replaces a plugin's source in the working tree would lose what git keeps nowhere.</summary>
internal readonly record struct WorkingTreeLoss(bool Unreadable, string Message);

internal static class WorkingTreeCheck
{
    /// <summary>Null when the plugin's source holds no working-tree change that <paramref name="gesture"/> would replace.</summary>
    internal static WorkingTreeLoss? Of(ISourceRepository repository, PluginAddress plugin, string gesture)
    {
        if (!repository.WorkingTreeChangesOf(plugin).Holds(out var changes, out var unread))
            return new WorkingTreeLoss(Unreadable: true, $"Could not read what changed in {plugin.Name}'s source: {unread.Reason}");

        return changes.Count > 0
            ? new WorkingTreeLoss(Unreadable: false,
                $"{plugin.Name}'s source has working-tree changes that {gesture} would replace: {string.Join(", ", changes)}. "
                + "Commit or discard them, or request it again with force to replace them.")
            : null;
    }
}
