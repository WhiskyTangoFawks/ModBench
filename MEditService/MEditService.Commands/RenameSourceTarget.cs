using System.Diagnostics.CodeAnalysis;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>The plugin a rename acts on and the mod that provides it.</summary>
internal sealed record RenameSourceTarget(RegisteredPlugin Plugin, PluginProvider.FromMod Mod)
{
    /// <summary>The target, or why renaming the plugin's source to <paramref name="newName"/> is refused before any write.</summary>
    internal static bool Of(
        ISourceAdapter source, LoadOrderSnapshot loadOrder, PluginAddress plugin, string newName,
        [NotNullWhen(true)] out RenameSourceTarget? target, [NotNullWhen(false)] out (RenameSourceRefusal Refusal, string Message)? refusal)
    {
        (target, refusal) = (null, null);
        if (source.WhyGitCannotRun() is { } gitMissing)
            refusal = (RenameSourceRefusal.GitUnavailable, gitMissing.Reason);
        else if (!ModKey.TryFromFileName(newName, out _))
            refusal = (RenameSourceRefusal.NotAPluginFile, NotAPluginFile.Message(newName, loadOrder.GameRelease));
        else if (loadOrder.Plugin(plugin) is not { } loaded)
        {
            refusal = (RenameSourceRefusal.PluginNotLoaded,
                $"{plugin.Name} from '{plugin.Origin}' is not in the load order, so there is no source to rename.");
        }
        else if (loaded.Provider is not PluginProvider.FromMod mod)
            refusal = (RenameSourceRefusal.NotInAMod, $"{plugin.Name} from '{plugin.Origin}' is in no mod, so it is not renamed.");
        else
            target = new RenameSourceTarget(loaded, mod);
        return target is not null;
    }
}
