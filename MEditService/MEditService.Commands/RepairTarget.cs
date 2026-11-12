using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>A plugin decompile and repair acts on, with its diagnoses, or why it cannot be.</summary>
internal abstract record RepairTarget
{
    internal sealed record Diagnosed(RegisteredPlugin Plugin, PluginProvider.FromMod Mod) : RepairTarget;

    internal sealed record Refused(DecompileAndRepairRefusal Refusal, string Message) : RepairTarget;

    internal static RepairTarget Of(PluginRepairer repairer, LoadOrderSnapshot loadOrder, PluginAddress key)
    {
        if (loadOrder.Plugin(key) is not { } plugin)
        {
            return new Refused(DecompileAndRepairRefusal.PluginNotLoaded,
                $"{key.Name} from '{key.Origin}' is not in the load order, so there is nothing to repair.");
        }
        if (plugin.Provider is not PluginProvider.FromMod mod)
        {
            return new Refused(DecompileAndRepairRefusal.NotFromAMod,
                $"{plugin.Name} comes from the game or from no mod, so no mod can hold its source.");
        }
        if (!repairer.Diagnose(loadOrder, plugin).Holds(out var diagnoses, out var unread))
            return new Refused(DecompileAndRepairRefusal.Unreadable, $"{plugin.Name} could not be read: {unread.Reason}");
        return diagnoses.Count == 0
            ? new Refused(DecompileAndRepairRefusal.NotMalformed, $"{plugin.Name} is not malformed, so there is nothing to repair.")
            : new Diagnosed(plugin, mod);
    }
}
