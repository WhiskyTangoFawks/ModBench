using System.Diagnostics;
using System.Text;
using MEditService.Commands.Composition;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Watcher.Tests.TestSupport;

/// <summary>A real mod tree under a live watch, driven by real file events, load-order changes
/// through the holder, and a clock the test owns. Nothing settles until the test advances that
/// clock.</summary>
internal sealed class WatchedTree : IDisposable
{
    private static readonly TimeSpan DefaultQuiet = TimeSpan.FromMilliseconds(300);
    private static readonly TimeSpan DefaultMaxWindow = TimeSpan.FromSeconds(2);

    internal TimeSpan Quiet { get; }
    internal TimeSpan MaxWindow { get; }

    // Whichever timer is armed is due after this, so one turn closes any open batch.
    private TimeSpan PastBothWindows => MaxWindow + Quiet;

    // The one bound in this harness: how long the operating system may take to deliver an event,
    // or a dedicated thread to run. Exceeding it fails the wait rather than passing it.
    internal static readonly TimeSpan DeliveryBound = TimeSpan.FromSeconds(30);

    internal ObservingClock Clock { get; }
    internal RecordingRefreshIndex Index { get; }
    internal InMemoryNotificationPublisher Notifications { get; } = new();
    internal LoadOrderHolder Holder { get; } = new();
    internal ModFolderWatcher Watcher { get; }

    private readonly List<LogEntry> _log = [];

    /// <summary>What the watcher reported: everything above the Debug trace lines.</summary>
    internal IReadOnlyList<LogEntry> LogEntries
    {
        get { lock (_log) return [.. _log.Where(e => e.Level > LogLevel.Debug)]; }
    }

    internal string InstanceRoot { get; }
    internal string GameDirectory { get; }

    // Outside every watch and on the same filesystem, so a file staged here reaches its mod folder
    // as a single rename.
    private readonly string _staging;

    private readonly List<RegisteredCopy> _copies = [];

    /// <summary>The watcher's verb as the composition root builds it, over the port this tree
    /// reads.</summary>
    internal static TrackedModSettled Settled(InMemoryNotificationPublisher notifications) =>
        notifications.RegisterIn(new ServiceCollection())
            .AddCommandHandlers()
            .BuildServiceProvider()
            .GetRequiredService<TrackedModSettled>();

    internal WatchedTree(IndexWriteGate? writeGate = null, TimeSpan? quiet = null, TimeSpan? maxWindow = null)
    {
        Quiet = quiet ?? DefaultQuiet;
        MaxWindow = maxWindow ?? DefaultMaxWindow;
        Clock = new ObservingClock(Quiet, MaxWindow);
        Index = new RecordingRefreshIndex(writeGate);
        InstanceRoot = Directory.CreateTempSubdirectory("medit-watch-").FullName;
        GameDirectory = Directory.CreateDirectory(Path.Combine(InstanceRoot, "Data")).FullName;
        _staging = Directory.CreateDirectory(Path.Combine(InstanceRoot, "staging")).FullName;
        Watcher = new ModFolderWatcher(
            Holder, Index, Settled(Notifications), new CollectingLogger(_log), Quiet, MaxWindow, Clock);
        Watcher.Subscribe();
    }

    /// <summary>A mod folder holding one plugin binary, registered in the load order this tree
    /// applies. The folder is the plugin's own directory, which is what names a mod here.</summary>
    internal string AddMod(string origin, string pluginName, byte[]? bytes = null)
    {
        var modFolder = Directory.CreateDirectory(Path.Combine(InstanceRoot, "mods", origin)).FullName;
        AddCopy(origin, modFolder, pluginName, bytes);
        return modFolder;
    }

    /// <summary>A second plugin in a mod folder that already exists.</summary>
    internal void AddCopy(string origin, string modFolder, string pluginName, byte[]? bytes = null)
    {
        var pluginPath = Path.Combine(modFolder, pluginName);
        File.WriteAllBytes(pluginPath, bytes ?? "a plugin binary"u8.ToArray());
        _copies.Add(new RegisteredCopy(pluginName, origin, pluginPath, Slot: _copies.Count, Enabled: true, Winning: true));
    }

    internal static string PluginPath(string modFolder, string pluginName) => Path.Combine(modFolder, pluginName);

    /// <summary>The bytes on disk as the Index would hash them, for seeding a copy as already
    /// indexed and for parking a compile.</summary>
    internal static string ContentHashOf(string path) =>
        Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)));

    /// <summary>A repository in the mod folder, written in Track's own order: the repository first,
    /// then each plugin's source root. Each binary is parked as its last compile, so unchanged
    /// bytes classify as nothing changed.</summary>
    internal static void Track(string modFolder, params string[] plugins)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        GitProbe.Run(gitDir, modFolder, "init", "-q", "-b", "main");
        GitProbe.Run(gitDir, modFolder, "config", "user.email", "watch@example.invalid");
        GitProbe.Run(gitDir, modFolder, "config", "user.name", "Watch Fixture");
        GitProbe.Run(gitDir, modFolder, "config", "commit.gpgsign", "false");
        foreach (var plugin in plugins) Directory.CreateDirectory(SourceRepository.RootIn(modFolder, plugin));
        GitProbe.Run(gitDir, modFolder, "add", "-A");
        GitProbe.Run(gitDir, modFolder, "commit", "-q", "--allow-empty", "-m", "tracked");
        foreach (var plugin in plugins)
        {
            var path = PluginPath(modFolder, plugin);
            if (File.Exists(path)) SourceRepository.ParkCompileSnapshot(modFolder, plugin, "HEAD", ContentHashOf(path));
        }
    }

    /// <summary>Drops a copy from the load order this tree applies, for a reconcile whose plugin
    /// set has shrunk.</summary>
    internal void RemoveCopy(string pluginName) =>
        _copies.RemoveAll(c => c.Name.Equals(pluginName, StringComparison.Ordinal));

    internal LoadOrderSnapshot Snapshot() =>
        new(GameDirectory, InstanceRoot, GameRelease.Fallout4, [.. _copies]);

    /// <summary>Hands the load order to the holder and returns once the watcher has reconciled it
    /// and every tracked mod's load-time settle has run, the two awaited on their own since they
    /// run beside each other.</summary>
    internal async Task ApplyLoadOrder()
    {
        var reconciled = Index.Reconciles.Count;
        var expected = LoadSettles() + TrackedModsInSnapshot();
        Holder.Apply(Snapshot());
        Assert.True(await Reached(() => Index.Reconciles.Count > reconciled), "the load-order change never reconciled");
        Assert.True(await Reached(() => LoadSettles() >= expected), "a tracked mod's load-time settle never ran");
    }

    private int TrackedModsInSnapshot() =>
        _copies.Select(c => LoadOrderSnapshot.ModFolderOf(c.Origin, c.Path))
            .Where(folder => folder is not null && SourceRepository.IsTracked(folder))
            .Distinct(StringComparer.Ordinal)
            .Count();

    // The watcher's own trace line per tracked mod, one level below anything a test reads as a
    // report.
    private int LoadSettles()
    {
        lock (_log) return _log.Count(e => e.Message.StartsWith("Load-time settle of ", StringComparison.Ordinal));
    }

    /// <summary>A document whose body names the record it carries, which is what lets the batch be
    /// refreshed by key rather than validated whole.</summary>
    internal string WriteRecord(string modFolder, string plugin, string formKey)
    {
        var path = Path.Combine(SourceRepository.RootIn(modFolder, plugin), $"Named - {formKey.Replace(':', '_')}.json");
        MoveIn(path, $$"""{"FormKey":"{{formKey}}"}""");
        return path;
    }

    /// <summary>A document naming no record, so the batch it lands in can only be a whole-copy
    /// validate.</summary>
    internal string WriteUnnamedDocument(string modFolder, string plugin, string name = "record.json")
    {
        var path = Path.Combine(SourceRepository.RootIn(modFolder, plugin), name);
        MoveIn(path, Guid.NewGuid().ToString());
        return path;
    }

    /// <summary>Another tool's compile or install: any file under the mod folder, written whole
    /// under the live watch.</summary>
    internal void WriteFile(string path, byte[] bytes) => MoveIn(path, bytes);

    internal void MoveRef(string modFolder) =>
        MoveIn(SourceRepository.GitWatchPathsIn(modFolder).Head, "ref: refs/heads/main\n");

    private void MoveIn(string path, string text) => MoveIn(path, Encoding.UTF8.GetBytes(text));

    // One file event, never the create-and-modify pair a direct write raises: what a watch
    // observes is then countable, and no window closes holding half a write.
    private void MoveIn(string path, byte[] bytes)
    {
        var staged = Path.Combine(_staging, Guid.NewGuid().ToString("n"));
        File.WriteAllBytes(staged, bytes);
        File.Move(staged, path, overwrite: true);
    }

    /// <summary>Performs the writes and returns once the watcher's own watches have observed every
    /// one of them: each write here raises exactly one file event.</summary>
    internal async Task Observes(params Action[] writes)
    {
        var expected = Clock.Observations + writes.Length;
        foreach (var write in writes) write();
        await Reached(() => Clock.Observations >= expected);
        Assert.True(Clock.Observations == expected,
            $"expected {expected} observations, saw {Clock.Observations}");
    }

    /// <summary>Advances past both windows until <paramref name="reached"/> holds. The clock is the
    /// only thing that closes a batch, so no batch lands between turns.</summary>
    internal Task<bool> Settles(Func<bool> reached) =>
        Reached(() =>
        {
            Clock.Advance(PastBothWindows);
            return reached();
        });

    internal static async Task<bool> Reached(Func<bool> reached)
    {
        var bound = Stopwatch.StartNew();
        while (bound.Elapsed < DeliveryBound)
        {
            if (reached()) return true;
            await Task.Delay(10);
        }
        return reached();
    }

    internal void AdvancePastBothWindows() => Clock.Advance(PastBothWindows);

    /// <summary>Puts the repository aside, the way another tool's reinstall replaces it. Renamed
    /// in place, never moved out: a watched directory moved out of a live watch loses its own
    /// event and the next one.</summary>
    internal static void RemoveRepository(string modFolder) =>
        Directory.Move(
            SourceRepository.GitWatchPathsIn(modFolder).GitDirectory,
            Path.Combine(modFolder, ".git.replaced"));

    public void Dispose()
    {
        Watcher.Dispose();
        try { Directory.Delete(InstanceRoot, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
