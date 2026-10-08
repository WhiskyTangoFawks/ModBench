using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A reload landing mid-gesture: the first plugin opened for reading replaces the held load
/// order with one that lacks <paramref name="dropped"/>.</summary>
internal sealed class DroppingAPluginOnTheFirstRead(LoadOrderHolder holder, string dropped)
    : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    private bool _dropped;

    public override IPluginRecordLookup OpenRecordLookup(
        RegisteredPlugin plugin, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (!_dropped)
        {
            _dropped = true;
            var held = holder.Current;
            holder.Apply(new LoadOrderSnapshot(
                held.DataFolderPath, held.InstanceRoot, held.GameRelease,
                [.. held.Plugins.Where(p => p.Name != dropped)],
                [.. held.Active.Where(p => p.Name != dropped).Select(p => p.Key)],
                [.. held.LoadedWithNoLine.Where(p => p.Name != dropped).Select(p => p.Key)]));
        }
        return base.OpenRecordLookup(plugin, gameRelease, schemas);
    }
}
