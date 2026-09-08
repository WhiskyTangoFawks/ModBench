using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;

namespace MEditService.Core.Commands;

/// <summary>A read, not a mutation. It answers from the source tree and load order, unreachable
/// from the read side, so it draws through the same allocator <see cref="WriteTargets"/> holds,
/// agreeing with Create's own FormKey.</summary>
public sealed class PeekNextFreeFormKeyHandler
{
    private readonly WriteTargets _targets;
    private readonly LoadOrderHolder _loadOrder;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Core.Composition) rather than the host naming a type it cannot see.
    internal PeekNextFreeFormKeyHandler(WriteTargets targets, LoadOrderHolder loadOrder) =>
        (_targets, _loadOrder) = (targets, loadOrder);

    /// <summary>The allocator Create and Renumber use, exposed so the Renumber box can prefill a
    /// suggestion as xEdit does. A tracked copy answers from its tree and HEAD, an untracked one from
    /// its own binary.</summary>
    public RecordEditResult PeekNextFreeFormKey(PluginKey plugin)
    {
        // No snapshot yet is a state, not a refusal about this plugin.
        if (_loadOrder.Current.Copies.Count == 0)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No load order has been received.");

        // Never a write, so no write gate and no tracked gate: an untracked copy answers too. A copy
        // the load order does not register is the one left with nothing to answer from.
        if (_loadOrder.Current.Copy(plugin) is not { } copy)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"The load order does not hold {plugin.Name} ({plugin.Origin}).");
        }

        WriteTargets.Allocator allocator;
        try
        {
            allocator = _targets.AllocatorFor(copy, plugin);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // Registered and unreadable: MO2 replaces and removes a copy's file whenever it likes, and
            // a read says so rather than faulting.
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordParseFailed,
                $"{plugin.Name} could not be read, so nothing can say which of its FormIDs are free: {ex.Message}");
        }

        var formKey = WriteTargets.NextFreeNativeFormId(allocator, allocator.IsLight);
        return formKey != null
            ? RecordEditResult.Success(formKey)
            : RecordEditResult.Refused(
                RecordEditRefusal.FormKeySpaceExhausted,
                WriteTargets.FormKeySpaceExhaustedMessage(plugin, allocator.IsLight));
    }
}
