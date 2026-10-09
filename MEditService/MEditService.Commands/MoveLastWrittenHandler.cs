using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Move last written, the second write of renaming a plugin: what Modbench last wrote for it takes the new
/// name, once VS Code has applied and saved the source rename.</summary>
public sealed class MoveLastWrittenHandler
{
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal MoveLastWrittenHandler(LoadOrderHolder loadOrder) => _loadOrder = loadOrder;

    /// <summary>What Modbench last wrote for the plugin becomes <paramref name="newName"/>'s. A refusal leaves it where
    /// it was. Throws <see cref="NoLoadOrderException"/> when no load order is held.</summary>
    public RenameSourceResult MoveLastWritten(PluginAddress plugin, string newName)
    {
        var loadOrder = _loadOrder.Require();
        if (!RenameSourceTarget.Of(loadOrder, plugin, newName, out var target, out var refused)) return refused;

        return SourceRepository.Over(target.Mod, loadOrder.GameRelease).MoveLastWrittenTo(plugin, newName) switch
        {
            null => new RenameSourceResult(),
            SourceFailure.GitUnavailable unavailable => RenameSourceTarget.Refused(RenameSourceRefusal.GitUnavailable, unavailable.Reason),
            { } failure => RenameSourceTarget.Refused(
                RenameSourceRefusal.WriteFailed, $"Could not move what Modbench last wrote for {plugin.Name}: {failure.Reason}"),
        };
    }
}
