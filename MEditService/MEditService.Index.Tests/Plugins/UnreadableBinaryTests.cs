using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

// plugins.md, A row, Plugin, "Failed to read": a binary that cannot be read fails its own plugin,
// and is read again once its bytes change, never on a snapshot that merely names it again.
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

    // A tracked plugin whose repository went reads its binary now, and that binary does not read.
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

    // plugins.md, A row, Plugin: "Failed to read" is the plugin's own status; story 6's failed
    // index is for a failure of the index itself.
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

        Reconcile(Entry, OtherEntry);

        Assert.Equal(before, _notifications.Notifications.Count);
    }

    [Fact]
    public void AReDerivationThatCannotReadTheBinary_ReadsAgainOnceItsBytesChange()
    {
        UntrackedOverAnUnreadableBinary();

        WriteValidPlugin(_pluginPath);
        Reconcile(Entry, OtherEntry);

        Assert.DoesNotContain(_index.Status.Failures, f => f.Name == PluginName);
        Assert.Contains(_index.RequireReads().GetDocuments(_key), d => d.EditorId == "FreshlyAppearedNpc");
    }

    // The rival this pins: a not-yet-held failure that only logs, leaving Status at whatever it
    // already was — ADR-0019 bans a failure a subscriber has no way to learn about.
    [Fact]
    public void ABinaryThatStillFailsToOpen_OnceItsBytesChange_PublishesStatus()
    {
        File.WriteAllText(_pluginPath, "not a plugin");
        Reconcile(Entry);
        var before = _notifications.Notifications.Count;

        File.WriteAllText(_pluginPath, "still not a plugin");
        Reconcile(Entry);

        var published = _notifications.Notifications.Skip(before).OfType<LoadOrderStatusNotification>().Last();
        Assert.Contains(published.Status.Failures, f => f.Name == PluginName);
    }
}
