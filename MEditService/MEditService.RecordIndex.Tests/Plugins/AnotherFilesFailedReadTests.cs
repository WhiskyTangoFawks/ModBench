using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class AnotherFilesFailedReadTests : IDisposable
{
    private readonly ScratchDirectory _scratch = new("medit-another-files-failed-read-");
    private readonly LoadOrderHolder _holder = new();

    public void Dispose() => _scratch.Dispose();

    private static bool Failed(OpenedIndex index, ModKey plugin) => index.Status.Failures.Any(f => f.Name == plugin.FileName.String);

    [Fact]
    public void APluginWhoseMasterAnotherProcessHeld_IsReadAgainOnceTheMasterIsFree()
    {
        var loadOrder = LightMasterAndChild.LoadOrderIn(_scratch.Path);
        using var index = Indexes.Open(_holder);
        using (File.Open(Path.Combine(_scratch.Path, LightMasterAndChild.Master.FileName), FileMode.Open, FileAccess.Read, FileShare.None))
        {
            index.Receive(_holder, loadOrder);
            Assert.True(Failed(index, LightMasterAndChild.Child));
        }

        index.NextSnapshotUntil(() => !Failed(index, LightMasterAndChild.Child), "the plugin read again");
    }

    [Fact]
    public void APluginWhoseMasterTheLoadOrderDidNotHold_IsReadAgainOnceItDoes()
    {
        var (masterPath, childPath) = LightMasterAndChild.Write(_scratch.Path);
        var master = new LoadOrderEntry(LightMasterAndChild.Master.FileName, masterPath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true);
        var child = new LoadOrderEntry(LightMasterAndChild.Child.FileName, childPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true);
        using var index = Indexes.Open(_holder);
        index.Reconcile(_holder, _scratch.Path, [child], GameRelease.Starfield);
        Assert.Contains("which the load order does not hold", index.Status.Failures.Single().Reason, StringComparison.Ordinal);

        index.Reconcile(_holder, _scratch.Path, [master, child], GameRelease.Starfield);

        Assert.False(Failed(index, LightMasterAndChild.Child));
    }

    [Fact]
    public void APluginWhoseStringsArchiveWasCorrupt_IsReadAgainOnceTheArchiveIsRepaired()
    {
        var plugin = ModKey.FromFileName("Localized.esp");
        var pluginPath = Path.Combine(_scratch.Path, plugin.FileName);
        var mod = new SkyrimMod(plugin, SkyrimRelease.SkyrimSE) { UsingLocalization = true };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, "The Big Door");
        ((IModGetter)mod).WriteToBinary(pluginPath);
        var looseStrings = Path.Combine(_scratch.Path, "Strings");
        var archive = Path.Combine(_scratch.Path, "Localized.bsa");
        var repaired = Path.Combine(Directory.CreateDirectory(Path.Combine(_scratch.Path, "Repaired")).FullName, "Localized.bsa");
        StringsArchive.Pack(Directory.EnumerateFiles(looseStrings), repaired);
        Directory.Delete(looseStrings, recursive: true);
        File.WriteAllText(archive, "not an archive");
        using var index = Indexes.Open(_holder);
        index.Reconcile(_holder, _scratch.Path,
            [new LoadOrderEntry(plugin.FileName, pluginPath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true)],
            GameRelease.SkyrimSE);
        Assert.True(Failed(index, plugin));

        File.Copy(repaired, archive, overwrite: true);

        index.NextSnapshotUntil(() => !Failed(index, plugin), "the plugin read again");
    }
}
