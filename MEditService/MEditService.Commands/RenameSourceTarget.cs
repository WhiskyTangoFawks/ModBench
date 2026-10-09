using System.Diagnostics.CodeAnalysis;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>The plugin a rename of its source acts on and the mod that provides it.</summary>
internal sealed record RenameSourceTarget(RegisteredPlugin Plugin, PluginProvider.FromMod Mod)
{
    internal static RenameSourceResult Refused(RenameSourceRefusal refusal, string message) => new(Refusal: refusal, Message: message);

    /// <summary>The target, or why renaming the plugin's source to <paramref name="newName"/> is refused before any write.</summary>
    internal static bool Of(
        LoadOrderSnapshot loadOrder, PluginAddress plugin, string newName,
        [NotNullWhen(true)] out RenameSourceTarget? target, [NotNullWhen(false)] out RenameSourceResult? refusal)
    {
        (target, refusal) = (null, null);
        if (SourceRepository.WhyGitCannotRun() is { } gitMissing)
            refusal = Refused(RenameSourceRefusal.GitUnavailable, gitMissing.Reason);
        else if (!ModKey.TryFromFileName(newName, out _))
            refusal = Refused(RenameSourceRefusal.NotAPluginFile, NotAPluginFile.Message(newName, loadOrder.GameRelease));
        else if (loadOrder.Plugin(plugin) is not { } loaded)
        {
            refusal = Refused(RenameSourceRefusal.PluginNotLoaded,
                $"{plugin.Name} from '{plugin.Origin}' is not in the load order, so there is no source to rename.");
        }
        else if (loaded.Provider is not PluginProvider.FromMod mod)
            refusal = Refused(RenameSourceRefusal.NotTracked, $"{plugin.Name} has no plugin source, so there is none to rename.");
        else
            target = new RenameSourceTarget(loaded, mod);
        return target is not null;
    }
}
