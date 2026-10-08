using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

public sealed class SecondWindowRefusedTests
{
    private static OpenedIndex MakeIndex(LoadOrderHolder holder) => Indexes.Open(holder);

    [ForeignIndexHolderFact]
    public void ASecondWindowOnTheSameInstance_IsAnsweredHeldElsewhereByName_ReadsNothing_MintsNoFile_AndLoadsOnceTheFirstCloses()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("second-window")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .Build();
        using (var earlier = MakeIndex(holder)) earlier.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var indexPath = IndexFiles.In(data.InstanceRoot);
        var indexDir = Path.GetDirectoryName(indexPath) ?? throw new InvalidOperationException($"Expected '{indexPath}' to have a parent directory.");

        using var otherWindow = ForeignIndexHolder.Hold(indexPath);
        var filesWhileHeld = Directory.GetFiles(indexDir).Select(Path.GetFileName).Order().ToList();

        using var index = MakeIndex(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(LoadOrderState.HeldElsewhere, index.Status.State);
        Assert.Contains("another Modbench window", index.Status.Message, StringComparison.Ordinal);
        Assert.Throws<NoLoadOrderException>(() => index.Records.GetPlugins());
        Assert.Equal(filesWhileHeld, Directory.GetFiles(indexDir).Select(Path.GetFileName).Order().ToList());

        otherWindow.Dispose();
        index.NextSnapshotUntil(() => index.Status.State == LoadOrderState.Ready, "the retried reconcile's ready status");
        Assert.NotEmpty(index.ListedIn(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));
    }
}
