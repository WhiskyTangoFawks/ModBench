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

    /// <summary>What Modbench last wrote for the plugin, filed under <paramref name="treeName"/>, becomes
    /// <paramref name="newName"/>'s. A refusal leaves it where it was. Throws <see cref="NoLoadOrderException"/>
    /// when no load order is held.</summary>
    public MoveLastWrittenResult MoveLastWritten(PluginAddress plugin, string treeName, string newName)
    {
        var loadOrder = _loadOrder.Require();
        if (!RenameSourceTarget.Of(loadOrder, plugin, newName, out var target, out var refused))
            return new MoveLastWrittenResult(refused.Value.Refusal, refused.Value.Message);

        return SourceRepository.Over(target.Mod, loadOrder.GameRelease).MoveLastWrittenTo(treeName, newName) switch
        {
            null => new MoveLastWrittenResult(),
            SourceFailure.GitUnavailable unavailable => new MoveLastWrittenResult(RenameSourceRefusal.GitUnavailable, unavailable.Reason),
            { } failure => new MoveLastWrittenResult(
                RenameSourceRefusal.WriteFailed, $"Could not move what Modbench last wrote for {plugin.Name}: {failure.Reason}"),
        };
    }
}
