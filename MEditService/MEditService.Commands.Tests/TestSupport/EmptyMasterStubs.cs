using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

internal static class EmptyMasterStubs
{
    internal static LoadOrderSnapshot LoadOrderOver(string pluginPath, string origin, string gameDirectory)
    {
        var pluginName = Path.GetFileName(pluginPath);
        var inputs = new List<LoadOrderEntry>();
        using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(pluginName), pluginPath), Fallout4Release.Fallout4))
        {
            foreach (var master in overlay.ModHeader.MasterReferences)
            {
                var emptyMasterStubPath = Path.Combine(gameDirectory, master.Master.FileName);
                new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(emptyMasterStubPath);
                inputs.Add(new LoadOrderEntry(master.Master.FileName, emptyMasterStubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
            }
        }
        inputs.Add(new LoadOrderEntry(pluginName, pluginPath, origin, Slot: inputs.Count, Enabled: true, Winning: true));

        return SnapshotPlugins.Snapshot(gameDirectory, instanceRoot: null, GameRelease.Fallout4, inputs);
    }
}
