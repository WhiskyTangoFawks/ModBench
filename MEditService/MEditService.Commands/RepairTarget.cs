using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Repair;

namespace MEditService.Commands;

/// <summary>A plugin decompile and repair acts on, with its diagnoses, or why it cannot be.</summary>
internal abstract record RepairTarget
{
    internal sealed record Diagnosed(RegisteredPlugin Plugin, PluginProvider.FromMod Mod) : RepairTarget;

    internal sealed record Refused(DecompileAndRepairRefusal Refusal, string Message) : RepairTarget;

    internal static RepairTarget Of(
        PluginRepairer repairer, LoadOrderSnapshot loadOrder, PluginAddress key, IReadOnlySet<PluginAddress> named, Func<PluginProvider.FromMod, bool> inSourceMod)
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
        var inSource = inSourceMod(mod);
        if (!inSource)
        {
            var blockers = ModInit.ProvidedBy(loadOrder, mod.Name)
                .Where(other => !named.Contains(other.Key))
                .SelectMany(other => repairer.Diagnose(loadOrder, other).Holds(out var otherDiagnoses, out _) && otherDiagnoses.Count > 0
                    ? [(other.Name, Diagnoses: otherDiagnoses)]
                    : Array.Empty<(string Name, IReadOnlyList<RepairPreview> Diagnoses)>())
                .ToList();
            if (blockers.Count > 0)
            {
                var repairable = blockers.All(blocker => Malformations.RepairClears(blocker.Diagnoses));
                return new Refused(repairable ? DecompileAndRepairRefusal.OtherPluginRepairable : DecompileAndRepairRefusal.OtherPluginRefused,
                    $"{mod.Name} is not a source mod, and making a source folder for {plugin.Name} was refused: "
                    + string.Join('\n', blockers.Select(blocker => Malformations.CannotBecomeSource(blocker.Name, blocker.Diagnoses))));
            }
        }
        if (diagnoses.Count > 0) return new Diagnosed(plugin, mod);
        return new Refused(
            inSource ? DecompileAndRepairRefusal.NotMalformed : DecompileAndRepairRefusal.NotMalformedOutsideSourceMod,
            $"{plugin.Name} is not malformed, so there is nothing to repair.");
    }
}
