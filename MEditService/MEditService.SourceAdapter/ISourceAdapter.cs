using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>What the record index reads of tracked plugins' source trees. Each answers the folder as it
/// stands now: a mod manager can replace it wholesale.</summary>
public interface ISourceAdapter
{
    /// <summary>Whether the plugin's mod is tracked and holds the plugin's tree.</summary>
    bool SourceReads(RegisteredPlugin plugin);

    bool IsTracked(RegisteredPlugin plugin);

    /// <summary>The reads over <paramref name="provider"/>'s folder. One serves a batch, so what it learns of
    /// the tree is learned once.</summary>
    ISourceRepositoryReads Over(PluginProvider.FromMod provider, GameRelease release);
}
