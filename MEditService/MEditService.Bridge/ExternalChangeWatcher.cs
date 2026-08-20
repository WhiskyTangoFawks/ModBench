using System.Timers;
using MEditService.Core.Ledger;
using Timer = System.Timers.Timer;

namespace MEditService.Bridge;

/// <summary>
/// #417's live-watch half: a <see cref="FileSystemWatcher"/> per watched (mod folder, plugin) pair,
/// debounced, calling straight into <see cref="ExternalChangeClassifier"/> — the only mechanic this
/// class owns is the watch lifecycle and the pending-question queue; classification, self-echo
/// suppression and crash-marker suppression all live in <c>MEditService.Core.Ledger</c>, exactly as
/// the load-time hash check (a different caller entirely, wired from <c>MEditService.Api</c>) also
/// calls it. See this project's own <c>.csproj</c> description for the boundary this keeps.
/// </summary>
public sealed class ExternalChangeWatcher : IDisposable
{
    private readonly TimeSpan _debounce;
    private readonly object _gate = new();
    private readonly Dictionary<string, WatchEntry> _entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, PendingExternalChange> _pending = new(StringComparer.Ordinal);

    /// <param name="debounce">How long to wait after the last file-system event before reading and
    /// classifying the binary — collapses the several write events one plugin save can raise (xEdit,
    /// like most writers, does not always touch a file exactly once) into a single classification.
    /// Defaults to 300ms; tests override it to keep the suite fast.</param>
    public ExternalChangeWatcher(TimeSpan? debounce = null)
    {
        _debounce = debounce ?? TimeSpan.FromMilliseconds(300);
    }

    /// <summary>Starts watching one tracked plugin's binary for out-of-band writes. Re-watching an
    /// already-watched (modFolder, plugin) pair replaces the previous watch — the composition root
    /// (<c>MEditService.Api</c>) re-registers on every session load, and a stale watcher pointed at a
    /// plugin no longer in the session must not linger.</summary>
    public void Watch(string modFolder, string pluginName, string pluginPath)
    {
        var key = Key(modFolder, pluginName);
        var directory = Path.GetDirectoryName(pluginPath)
            ?? throw new ArgumentException($"'{pluginPath}' has no containing directory.", nameof(pluginPath));

        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var existing)) existing.Dispose();

            var fsWatcher = new FileSystemWatcher(directory, Path.GetFileName(pluginPath))
            {
                // FileName is required for Renamed to fire at all (confirmed empirically, not
                // assumed): a temp-file-then-rename commit — exactly how PluginWriter.Commit()
                // writes every binary, Save & Compile included — raises neither Changed nor
                // Created without it; .NET's Linux FileSystemWatcher (inotify-backed) gates the
                // Renamed event on this bit. Without it, the live watcher could not see Save &
                // Compile's own writes at all, by any event, which would have made self-echo
                // suppression untestable through this class (and the production watcher blind to
                // its own writes) rather than merely untested.
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName,
            };
            var debounceTimer = new Timer(_debounce.TotalMilliseconds) { AutoReset = false };
            debounceTimer.Elapsed += (_, _) => Settle(modFolder, pluginName, pluginPath);
            fsWatcher.Changed += (_, _) => Restart(debounceTimer);
            fsWatcher.Created += (_, _) => Restart(debounceTimer);
            // A rename *into* the watched filename (PluginWriter.Commit()'s File.Move(tmpPath,
            // finalPath), the shape every production binary write actually takes) surfaces here,
            // never as Changed/Created — see the NotifyFilter comment above.
            fsWatcher.Renamed += (_, _) => Restart(debounceTimer);
            fsWatcher.EnableRaisingEvents = true;

            _entries[key] = new WatchEntry(fsWatcher, debounceTimer);
        }
    }

    /// <summary>Stops watching — the composition root calls this for every plugin a reload no longer
    /// names, so a session change never leaves a watcher pointed at a folder that isn't loaded any
    /// more.</summary>
    public void Unwatch(string modFolder, string pluginName)
    {
        lock (_gate)
        {
            var key = Key(modFolder, pluginName);
            if (_entries.Remove(key, out var entry)) entry.Dispose();
        }
    }

    /// <summary>Every plugin currently classified as a genuine, unanswered external change — never
    /// <see cref="ExternalChangeClassification.SelfEcho"/> or
    /// <see cref="ExternalChangeClassification.CrashRecovery"/>, which this class filters out before a
    /// question is ever queued. One entry per plugin: a second detection before the first is answered
    /// replaces the queued question rather than duplicating it.</summary>
    public IReadOnlyList<PendingExternalChange> Pending()
    {
        lock (_gate) return [.. _pending.Values];
    }

    /// <summary>Drops a plugin's queued question — called once the dialog has been answered (Absorb,
    /// Keep, or a fresh detection has superseded it), so a stale question never keeps re-surfacing
    /// after it was already resolved through some other path (e.g. the load-time check).</summary>
    public void ClearPending(string modFolder, string pluginName)
    {
        lock (_gate) _pending.Remove(Key(modFolder, pluginName));
    }

    /// <summary>Feeds a classification computed elsewhere straight into the same pending-question
    /// queue the live watcher itself fills from <see cref="Settle"/> — the load-time hash check
    /// (fired from <c>MEditService.Api</c>'s session-load handlers, which needs no live watch of its
    /// own to ask the question once) uses this so both triggers share one queue and one dialog
    /// surface.
    ///
    /// <para>Also the one place that sets <see cref="ExternalChangeDeferral"/>'s marker (#417 exit
    /// path 3: the plugin is refused for editing from the instant a question is detected, not only
    /// after an explicit Esc) — both triggers land here, so both get the refusal without either
    /// remembering to set it themselves.</para>
    /// </summary>
    public void ReportExternalChange(string modFolder, string pluginName, ExternalChangeClassification.ExternalChange classification)
    {
        lock (_gate) _pending[Key(modFolder, pluginName)] = new PendingExternalChange(modFolder, pluginName, classification);
        ExternalChangeDeferral.Set(modFolder, pluginName,
            $"{pluginName} (in {Path.GetFileName(modFolder.TrimEnd(Path.DirectorySeparatorChar))}) changed outside " +
            "Modbench and is awaiting an answer — Absorb Upstream Update or Keep as My Edit.");
    }

    private static void Restart(Timer debounceTimer)
    {
        debounceTimer.Stop();
        debounceTimer.Start();
    }

    private void Settle(string modFolder, string pluginName, string pluginPath)
    {
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(pluginPath);
        }
        catch (IOException)
        {
            // Caught mid-write by another process still holding the file — the debounce timer having
            // fired at all means at least one Changed event landed, so there is nothing further to
            // wait for from this class; a genuinely torn read is not this class's problem to solve,
            // and the load-time hash check remains the backstop if this particular event is missed.
            return;
        }

        var classification = ExternalChangeClassifier.Classify(modFolder, pluginName, bytes);
        if (classification is ExternalChangeClassification.ExternalChange externalChange)
            ReportExternalChange(modFolder, pluginName, externalChange);
    }

    private static string Key(string modFolder, string pluginName) =>
        $"{modFolder} {pluginName}";

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var entry in _entries.Values) entry.Dispose();
            _entries.Clear();
        }
    }

    private sealed class WatchEntry(FileSystemWatcher watcher, Timer debounceTimer) : IDisposable
    {
        public void Dispose()
        {
            watcher.Dispose();
            debounceTimer.Dispose();
        }
    }
}

/// <summary>One plugin's unanswered external-change question, as the watcher (or, once the load-time
/// check is wired, the same classification from that path) last observed it — what
/// <c>GET /plugins/external-changes/status</c> hands the extension to drive the one dialog.</summary>
public sealed record PendingExternalChange(string ModFolder, string PluginName, ExternalChangeClassification.ExternalChange Classification);
