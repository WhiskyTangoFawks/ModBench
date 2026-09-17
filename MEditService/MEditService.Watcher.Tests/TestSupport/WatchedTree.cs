using System.Diagnostics;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Watcher;
using Mutagen.Bethesda;
using FakeClock = Microsoft.Extensions.Time.Testing.FakeTimeProvider;

namespace MEditService.Tests.TestSupport;

/// <summary>A real mod tree under a live watch, driven by real file events and a clock the test
/// owns. Nothing settles until <see cref="Settles"/> advances that clock.</summary>
internal sealed class WatchedTree : IDisposable
{
    internal static readonly TimeSpan Quiet = TimeSpan.FromMilliseconds(300);
    internal static readonly TimeSpan MaxWindow = TimeSpan.FromSeconds(2);

    // Every turn of the settle loop jumps past both windows, so whichever timer is armed is due.
    private static readonly TimeSpan PastBothWindows = MaxWindow + Quiet;

    // A bound on the real time the operating system may take to deliver an event, never on when a
    // batch closes; exceeding it fails the wait rather than passing it.
    private static readonly TimeSpan DeliveryBound = TimeSpan.FromSeconds(30);

    internal FakeClock Clock { get; } = new(DateTimeOffset.UnixEpoch);
    internal RecordingRefreshIndex Index { get; } = new();
    internal InMemoryNotificationPublisher Notifications { get; } = new();
    internal LoadOrderHolder Holder { get; } = new();
    internal List<LogEntry> LogEntries { get; } = [];
    internal ModFolderWatcher Watcher { get; }

    internal string InstanceRoot { get; }
    internal string GameDirectory { get; }

    private readonly List<RegisteredCopy> _copies = [];

    internal WatchedTree()
    {
        InstanceRoot = Directory.CreateTempSubdirectory("medit-watch-").FullName;
        GameDirectory = Directory.CreateDirectory(Path.Combine(InstanceRoot, "Data")).FullName;
        Watcher = new ModFolderWatcher(
            Holder, Index, Notifications, new CollectingLogger(LogEntries), Quiet, MaxWindow, Clock);
    }

    /// <summary>A mod folder holding one plugin binary, registered in the load order this tree
    /// applies. The folder is the plugin's own directory, which is what names a mod here.</summary>
    internal string AddMod(string origin, string pluginName, byte[]? bytes = null)
    {
        var modFolder = Directory.CreateDirectory(Path.Combine(InstanceRoot, "mods", origin)).FullName;
        var pluginPath = Path.Combine(modFolder, pluginName);
        File.WriteAllBytes(pluginPath, bytes ?? "a plugin binary"u8.ToArray());
        _copies.Add(new RegisteredCopy(pluginName, origin, pluginPath, Slot: _copies.Count, Enabled: true, Winning: true));
        return modFolder;
    }

    /// <summary>A second plugin in a mod folder that already exists.</summary>
    internal void AddCopy(string origin, string modFolder, string pluginName)
    {
        var pluginPath = Path.Combine(modFolder, pluginName);
        File.WriteAllBytes(pluginPath, "a plugin binary"u8.ToArray());
        _copies.Add(new RegisteredCopy(pluginName, origin, pluginPath, Slot: _copies.Count, Enabled: true, Winning: true));
    }

    internal static string PluginPath(string modFolder, string pluginName) => Path.Combine(modFolder, pluginName);

    /// <summary>The bytes on disk as the Index would hash them, for seeding a copy as already
    /// indexed.</summary>
    internal static string ContentHashOf(string path) =>
        Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)));

    /// <summary>What makes a mod folder tracked is a repository in it, so this is git and the
    /// layout the repository itself names — never a hand-spelled source path.</summary>
    internal static void Track(string modFolder, params string[] plugins)
    {
        foreach (var plugin in plugins) Directory.CreateDirectory(SourceRepository.RootIn(modFolder, plugin));
        var gitDir = Path.Combine(modFolder, ".git");
        GitProbe.Run(gitDir, modFolder, "init", "-q", "-b", "main");
        GitProbe.Run(gitDir, modFolder, "config", "user.email", "watch@example.invalid");
        GitProbe.Run(gitDir, modFolder, "config", "user.name", "Watch Fixture");
        GitProbe.Run(gitDir, modFolder, "config", "commit.gpgsign", "false");
        GitProbe.Run(gitDir, modFolder, "add", "-A");
        GitProbe.Run(gitDir, modFolder, "commit", "-q", "--allow-empty", "-m", "tracked");
    }

    internal LoadOrderSnapshot Snapshot() =>
        new(GameDirectory, InstanceRoot, GameRelease.Fallout4, [.. _copies]);

    internal void ApplyLoadOrder() => Holder.Apply(Snapshot());

    /// <summary>A document whose body names the record it carries, which is what lets the batch be
    /// refreshed by key rather than validated whole.</summary>
    internal static string WriteRecord(string modFolder, string plugin, string formKey)
    {
        var path = Path.Combine(SourceRepository.RootIn(modFolder, plugin), $"Named - {formKey.Replace(':', '_')}.json");
        File.WriteAllText(path, $$"""{"FormKey":"{{formKey}}"}""");
        return path;
    }

    /// <summary>A document naming no record, so the batch it lands in can only be a whole-copy
    /// validate.</summary>
    internal static string WriteUnnamedDocument(string modFolder, string plugin)
    {
        var path = Path.Combine(SourceRepository.RootIn(modFolder, plugin), "record.json");
        File.WriteAllText(path, Guid.NewGuid().ToString());
        return path;
    }

    internal static void MoveRef(string modFolder) =>
        File.WriteAllText(SourceRepository.GitWatchPathsIn(modFolder).Head, "ref: refs/heads/main\n");

    /// <summary>Advances past both windows until <paramref name="reached"/> holds. The clock is the
    /// only thing that closes a batch, so no batch lands between turns.</summary>
    internal async Task<bool> Settles(Func<bool> reached)
    {
        var bound = Stopwatch.StartNew();
        while (bound.Elapsed < DeliveryBound)
        {
            Clock.Advance(PastBothWindows);
            if (reached()) return true;
            await Task.Delay(10);
        }
        return reached();
    }

    /// <summary>True when <paramref name="projected"/> never holds across a short allowance. Both
    /// windows are past on the first turn, so this waits out delivery, not a batch.</summary>
    internal async Task<bool> NothingReaches(Func<bool> projected)
    {
        var allowance = Stopwatch.StartNew();
        while (allowance.Elapsed < TimeSpan.FromSeconds(2))
        {
            Clock.Advance(PastBothWindows);
            if (projected()) return false;
            await Task.Delay(10);
        }
        return !projected();
    }

    public void Dispose()
    {
        Watcher.Dispose();
        try { Directory.Delete(InstanceRoot, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
