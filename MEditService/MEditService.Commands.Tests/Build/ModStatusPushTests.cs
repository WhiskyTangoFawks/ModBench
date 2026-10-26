using System.Collections.Concurrent;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Build;

public sealed class ModStatusPushTests : IDisposable
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(20);

    private readonly ScratchDirectory _dataFolder = new("medit-mod-status-");
    private readonly ScratchDirectory _instanceRoot = new("medit-mod-status-instance-");
    private readonly FakeModFolders _folders = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly BlockingCollection<IReadOnlyList<string>> _pushes = [];
    private readonly BlockingCollection<LogEntry> _errors = [];

    private readonly PutLoadOrderHandler _handler;

    public ModStatusPushTests()
    {
        _notifications.OnPublish = notification =>
        {
            if (notification is ModStatusChangedNotification pushed) _pushes.Add(pushed.Mods);
        };
        _handler = TestEditService.Over(
                new LoadOrderHolder(), logging: logging => logging.AddProvider(new CollectingLoggerProvider([], Logged)), notifications: _notifications,
                modFolders: _folders)
            .GetRequiredService<PutLoadOrderHandler>();
    }

    public void Dispose()
    {
        _dataFolder.Dispose();
        _instanceRoot.Dispose();
        _pushes.Dispose();
        _errors.Dispose();
    }

    private void Logged(LogEntry entry)
    {
        if (entry.Level == LogLevel.Error) _errors.Add(entry);
    }

    private void Put(params string[] mods) => Put([.. mods.Select(mod => new ModByFolder(mod, mod, ["meta.ini"], SourceFolder: null))]);

    private void Put(params ModByFolder[] mods) =>
        Assert.True(_handler.Put(_dataFolder, _instanceRoot, GameRelease.Fallout4, [], [], [], [], [], [], Language.English, new SnapshotMods(mods, "stat-cache")).Holds(out _, out _));

    private static ModByFolder Holding(string mod, string version) => new(mod, mod, ["meta.ini"], SourceFolder: null, new ModMetadata(version));

    private IReadOnlyList<string> NextPush() =>
        _pushes.TryTake(out var mods, Patience) ? mods : throw new TimeoutException("no mod status was pushed");

    private void Manifested(string mod) => _folders.WithFile(mod, "a.nif", "a").Manifests[mod] = new Manifest(null, [new ManifestFile("a.nif", new PackageEntry.NotHeld())]);

    [Fact]
    public void TheFirstSnapshot_PushesEveryMod()
    {
        Manifested("Clean");

        Put("Clean", "Unrecorded");

        Assert.Equal(["Clean", "Unrecorded"], NextPush());
    }

    [Fact]
    public void ASnapshot_PushesOnlyTheModsNewToIt()
    {
        Manifested("Kept");
        Put("Kept", "Unrecorded");
        NextPush();

        Put("Kept", "Unrecorded", "Installed");

        Assert.Equal(["Installed"], NextPush());
    }

    [Fact]
    public void ACheckThatThrows_IsLogged_AndTheNextSnapshotIsCheckedAllTheSame()
    {
        _folders.StatusThrows.Add("Broken");
        Put("Broken");
        var logged = _errors.TryTake(out var error, Patience) ? error : throw new TimeoutException("no failed check was logged");
        _folders.StatusThrows.Clear();

        Put("Recorded");

        Assert.Contains("'Broken' is not a path", logged.Exception?.Message, StringComparison.Ordinal);
        Assert.Equal(["Recorded"], NextPush());
    }

    [Fact]
    public void ASnapshot_PushesAModWhoseFolderChangedSinceTheLastPush_AndNotOneUnchanged()
    {
        Manifested("Edited");
        Manifested("Kept");
        Put("Edited", "Kept");
        NextPush();

        _folders.WithFile("Edited", "mine.txt", "mine");
        Put("Edited", "Kept");

        Assert.Equal(["Edited"], NextPush());
    }

    [Fact]
    public void ASnapshot_PushesAModWhoseMetadataNowDiffersFromItsManifest()
    {
        Manifested("Mod");
        Put(Holding("Mod", "1.0"));
        NextPush();

        _folders.MetadataDiffering.Add("Mod");
        Put(Holding("Mod", "2.0"));

        Assert.Equal(["Mod"], NextPush());
    }

    [Fact]
    public void ASnapshot_PushesAModWhoseMetadataCouldNotBeRead()
    {
        Manifested("Mod");
        Put(Holding("Mod", "1.0"));
        NextPush();

        Put(new ModByFolder("Mod", "Mod", ["meta.ini"], SourceFolder: null, MetadataUnreadable: "access denied"));

        Assert.Equal(["Mod"], NextPush());
    }
}
