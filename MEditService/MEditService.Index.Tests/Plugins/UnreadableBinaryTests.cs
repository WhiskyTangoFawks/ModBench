using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

public sealed class UnreadableBinaryTests : IDisposable
{
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly Indexer _index;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-unreadable-binary-game-").FullName;
    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-unreadable-binary-instance-").FullName;
    private const string PluginName = "Untracked.esp";
    private const string Origin = "UntrackedMod";
    private readonly string _modFolder;
    private readonly string _pluginPath;
    private readonly PluginAddress _key = new(PluginName, Origin);

    public UnreadableBinaryTests()
    {
        _index = Indexes.Open(_holder, notifications: _notifications);
        _modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        _pluginPath = Path.Combine(_modFolder, PluginName);
    }

    public void Dispose()
    {
        _index.Dispose();
        Directory.Delete(_gameDirectory, recursive: true);
        Directory.Delete(_instanceRoot, recursive: true);
    }

    private LoadOrderEntry Entry => new(PluginName, _pluginPath, Origin, 0, Enabled: true, Winning: true);

    private string OtherPluginPath => Path.Combine(_gameDirectory, "Other.esp");

    private LoadOrderEntry OtherEntry => new("Other.esp", OtherPluginPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true);

    private static void WriteValidPlugin(string path)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("FreshlyAppearedNpc");
        mod.WriteToBinary(path);
    }

    private void Reconcile(params LoadOrderEntry[] entries) =>
        _index.Reconcile(_holder, _gameDirectory, entries, GameRelease.Fallout4, _instanceRoot);

    private void UntrackedOverAnUnreadableBinary()
    {
        WriteValidPlugin(_pluginPath);
        TrackedMods.Track(_pluginPath, _gameDirectory);
        Reconcile(Entry);
        Directory.Delete(Path.Combine(_modFolder, ".git"), recursive: true);
        File.WriteAllText(_pluginPath, "not a plugin");
        var other = new Fallout4Mod(ModKey.FromFileName("Other.esp"), Fallout4Release.Fallout4);
        other.Npcs.AddNew("OtherNpc");
        other.WriteToBinary(OtherPluginPath);
        Reconcile(Entry, OtherEntry);
    }

    [Fact]
    public void AReDerivationThatCannotReadTheBinary_FailsThatPluginAlone_AndTheRestLand()
    {
        UntrackedOverAnUnreadableBinary();

        Assert.Equal(LoadOrderState.Ready, _index.Status.State);
        Assert.Contains(_index.Status.Failures, f => f.Name == PluginName && f.Origin == Origin);
        Assert.Contains(_index.RequireReads().GetDocuments(new PluginAddress("Other.esp", PluginOrigin.DataDirectory)),
            d => d.EditorId == "OtherNpc");
    }

    [Fact]
    public void AReDerivationThatCannotReadTheBinary_IsNotReadAgain_WhileItsBytesHold()
    {
        UntrackedOverAnUnreadableBinary();
        var before = _notifications.Notifications.Count;
        var other = new Fallout4Mod(ModKey.FromFileName("Other.esp"), Fallout4Release.Fallout4);
        other.Npcs.AddNew("OtherNpcChangedBesideTheUnreadableOne");
        other.WriteToBinary(OtherPluginPath);

        _index.NextSnapshot();

        Assert.DoesNotContain(_notifications.Notifications.Skip(before), n => n is LoadOrderStatusNotification);
    }

    [Fact]
    public void AReDerivationThatCannotReadTheBinary_ReadsAgainOnceItsBytesChange()
    {
        UntrackedOverAnUnreadableBinary();

        WriteValidPlugin(_pluginPath);
        _index.NextSnapshotUntil(() => _index.Status.Failures.All(f => f.Name != PluginName), "the status without the plugin's failure");

        Assert.DoesNotContain(_index.Status.Failures, f => f.Name == PluginName);
        Assert.Contains(_index.RequireReads().GetDocuments(_key), d => d.EditorId == "FreshlyAppearedNpc");
    }

    [Fact]
    public void ABinaryThatStillFailsToOpen_OnceItsBytesChange_PublishesStatus()
    {
        File.WriteAllText(_pluginPath, "not a plugin");
        Reconcile(Entry);
        var before = _notifications.Notifications.Count;

        File.WriteAllText(_pluginPath, "still not a plugin");
        _index.NextSnapshotUntil(
            () => _notifications.Since(before).OfType<LoadOrderStatusNotification>().Any(), "the status naming the failure again");

        var published = _notifications.Notifications.Skip(before).OfType<LoadOrderStatusNotification>().Last();
        Assert.Contains(published.Status.Failures, f => f.Name == PluginName);
    }
}
