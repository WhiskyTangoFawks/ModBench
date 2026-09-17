using System.Diagnostics;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Watcher;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using FakeClock = Microsoft.Extensions.Time.Testing.FakeTimeProvider;

namespace MEditService.Tests.TestSupport;

/// <summary>A real mod tree under a live watch, driven by real file events and a clock the test
/// owns. Nothing settles until the test advances that clock.</summary>
internal sealed class WatchedTree : IDisposable
{
    private static readonly TimeSpan DefaultQuiet = TimeSpan.FromMilliseconds(300);
    private static readonly TimeSpan DefaultMaxWindow = TimeSpan.FromSeconds(2);

    internal TimeSpan Quiet { get; }
    internal TimeSpan MaxWindow { get; }

    // Whichever timer is armed is due after this, so one turn closes any open batch.
    private TimeSpan PastBothWindows => MaxWindow + Quiet;

    // The one bound in this harness: how long the operating system may take to deliver an event.
    // Exceeding it fails the wait rather than passing it.
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

    internal WatchedTree(IndexWriteGate? writeGate = null, TimeSpan? quiet = null, TimeSpan? maxWindow = null)
    {
        Quiet = quiet ?? DefaultQuiet;
        MaxWindow = maxWindow ?? DefaultMaxWindow;
        Index = new RecordingRefreshIndex(writeGate);
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

    /// <summary>Drops a copy from the load order this tree applies, for a reconcile whose plugin
    /// set has shrunk.</summary>
    internal void RemoveCopy(string pluginName) =>
        _copies.RemoveAll(c => c.Name.Equals(pluginName, StringComparison.Ordinal));

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
    internal async Task<bool> Settles(Func<bool> reached, TimeSpan perTurn)
    {
        var bound = Stopwatch.StartNew();
        while (bound.Elapsed < DeliveryBound)
        {
            Clock.Advance(perTurn);
            if (reached()) return true;
            await Task.Delay(10);
        }
        return reached();
    }

    internal void AdvancePastBothWindows() => Clock.Advance(PastBothWindows);

    private const string ProbeOrigin = "DeliveryProbe";
    private const string ProbePlugin = "Probe.esp";

    /// <summary>A second watch over the same mod folder, registered for a plugin the subject never
    /// sees, so its probe settles a batch of its own without projecting into the subject's.</summary>
    internal DeliveryOracle ArmOracleIn(string modFolder)
    {
        var probePath = Path.Combine(modFolder, ProbePlugin);
        Directory.CreateDirectory(SourceRepository.RootIn(modFolder, ProbePlugin));

        // The probe copy lives only in the oracle's own load order: the subject never registers it,
        // so nothing the probe does can appear at the subject's doors.
        var probeOnly = new LoadOrderSnapshot(
            GameDirectory, InstanceRoot, GameRelease.Fallout4,
            [new RegisteredCopy(ProbePlugin, ProbeOrigin, probePath, Slot: 0, Enabled: true, Winning: true)]);
        var oracle = new DeliveryOracle(probeOnly, modFolder, Quiet, MaxWindow);
        oracle.Watcher.WatchSourceOf(ProbeOrigin);
        return oracle;
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
        private readonly FakeClock _clock = new(DateTimeOffset.UnixEpoch);
        private readonly RecordingRefreshIndex _index = new();
        private readonly string _modFolder;
        private int _probes;

        internal ModFolderWatcher Watcher { get; }

        private readonly TimeSpan _past;

        internal DeliveryOracle(LoadOrderSnapshot snapshot, string modFolder, TimeSpan quiet, TimeSpan maxWindow)
        {
            _modFolder = modFolder;
            _past = quiet + maxWindow;
            var holder = new LoadOrderHolder();
            holder.Apply(snapshot);
            Watcher = new ModFolderWatcher(
                holder, _index, new InMemoryNotificationPublisher(), NullLogger.Instance, quiet, maxWindow, _clock);
        }

        /// <summary>Writes a probe and settles on it. One watch delivers in order, so the probe
        /// landing says everything written before it has been observed too.</summary>
        internal async Task<bool> Delivered()
        {
            var before = _index.Of("projection").Count;
            WriteUnnamedDocument(_modFolder, ProbePlugin, $"probe-{++_probes}.json");

            var bound = Stopwatch.StartNew();
            while (bound.Elapsed < DeliveryBound)
            {
                _clock.Advance(_past);
                if (_index.Of("projection").Count > before) return true;
                await Task.Delay(10);
            }
            return false;
        }

        public void Dispose() => Watcher.Dispose();
    }
}
