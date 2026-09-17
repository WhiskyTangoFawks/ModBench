using System.Diagnostics;
using MEditService.Commands.Composition;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using FakeClock = Microsoft.Extensions.Time.Testing.FakeTimeProvider;

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

    internal FakeClock Clock { get; } = new(DateTimeOffset.UnixEpoch);
    internal RecordingRefreshIndex Index { get; }
    internal InMemoryNotificationPublisher Notifications { get; } = new();
    internal LoadOrderHolder Holder { get; } = new();
    internal List<LogEntry> LogEntries { get; } = [];
    internal ModFolderWatcher Watcher { get; }

    internal string InstanceRoot { get; }
    internal string GameDirectory { get; }

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
        Index = new RecordingRefreshIndex(writeGate);
        InstanceRoot = Directory.CreateTempSubdirectory("medit-watch-").FullName;
        GameDirectory = Directory.CreateDirectory(Path.Combine(InstanceRoot, "Data")).FullName;
        Watcher = new ModFolderWatcher(
            Holder, Index, Settled(Notifications), new CollectingLogger(LogEntries), Quiet, MaxWindow, Clock);
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

    /// <summary>What makes a mod folder tracked is a repository in it. Each plugin's binary is
    /// parked as its last compile, the state Track leaves, so unchanged bytes classify as nothing
    /// changed.</summary>
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

    /// <summary>Hands the load order to the holder and returns once the watcher has reconciled it.
    /// The reconcile is the last thing a change does, so from here every watch is armed and every
    /// load-time settle has run.</summary>
    internal async Task ApplyLoadOrder()
    {
        var before = Index.Reconciles.Count;
        Holder.Apply(Snapshot());
        Assert.True(await Reached(() => Index.Reconciles.Count > before), "the load-order change never reconciled");
    }

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
    internal static string WriteUnnamedDocument(string modFolder, string plugin, string name = "record.json")
    {
        var path = Path.Combine(SourceRepository.RootIn(modFolder, plugin), name);
        File.WriteAllText(path, Guid.NewGuid().ToString());
        return path;
    }

    internal static void MoveRef(string modFolder) =>
        File.WriteAllText(SourceRepository.GitWatchPathsIn(modFolder).Head, "ref: refs/heads/main\n");

    /// <summary>Advances past both windows until <paramref name="reached"/> holds. The clock is the
    /// only thing that closes a batch, so no batch lands between turns.</summary>
    internal Task<bool> Settles(Func<bool> reached) => Settles(reached, PastBothWindows);

    /// <summary>Advances by <paramref name="perTurn"/> until <paramref name="reached"/> holds, for a
    /// test whose subject is which of the two windows closed the batch.</summary>
    internal Task<bool> Settles(Func<bool> reached, TimeSpan perTurn) =>
        Reached(() =>
        {
            Clock.Advance(perTurn);
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

    private const string ProbePlugin = "Probe.esp";

    /// <summary>A second, recursive watch over the same mod folder, for a probe the subject never
    /// registers: its delivery says everything written before it has reached a watch on this folder
    /// too.</summary>
    internal static DeliveryOracle ArmOracleIn(string modFolder)
    {
        Directory.CreateDirectory(SourceRepository.RootIn(modFolder, ProbePlugin));
        return new DeliveryOracle(modFolder);
    }

    public void Dispose()
    {
        Watcher.Dispose();
        try { Directory.Delete(InstanceRoot, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    internal sealed class DeliveryOracle : IDisposable
    {
        private readonly FileSystemWatcher _watcher;
        private readonly string _modFolder;
        private readonly object _gate = new();
        private readonly HashSet<string> _seen = new(StringComparer.Ordinal);
        private int _probes;

        internal DeliveryOracle(string modFolder)
        {
            _modFolder = modFolder;
            _watcher = new FileSystemWatcher(modFolder)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName | NotifyFilters.DirectoryName,
            };
            _watcher.Created += (_, e) => Seen(e.FullPath);
            _watcher.Changed += (_, e) => Seen(e.FullPath);
            _watcher.EnableRaisingEvents = true;
        }

        private void Seen(string path)
        {
            lock (_gate) _seen.Add(path);
        }

        /// <summary>Writes a probe under the probe plugin's source root and waits for its event: the
        /// kernel queues each write to every watch on the folder in order.</summary>
        internal async Task<bool> Delivered()
        {
            var probe = WriteUnnamedDocument(_modFolder, ProbePlugin, $"probe-{++_probes}.json");
            return await Reached(() => { lock (_gate) return _seen.Contains(probe); });
        }

        public void Dispose() => _watcher.Dispose();
    }
}
