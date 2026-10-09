using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A reload landing mid-gesture: the first plugin opened for reading replaces the held load
/// order with one that lacks <paramref name="dropped"/>.</summary>
internal sealed class DroppingAPluginOnTheFirstRead(LoadOrderHolder holder, PluginAddress dropped)
    : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    private bool _dropped;

    public override Answer<IPluginRecords, PluginFailure> OpenRecordLookup(
        RegisteredPlugin plugin, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (!_dropped)
        {
            _dropped = true;
            var held = holder.Current;
            holder.Apply(new LoadOrderSnapshot(
                held.DataFolderPath, held.InstanceRoot, held.GameRelease,
                [.. held.Plugins.Where(p => !p.Key.Equals(dropped))],
                [.. held.Active.Select(p => p.Key).Where(a => !a.Equals(dropped))],
                [.. held.LoadedWithNoLine.Select(p => p.Key).Where(a => !a.Equals(dropped))]));
        }
        return base.OpenRecordLookup(plugin, gameRelease, schemas);
    }
}
