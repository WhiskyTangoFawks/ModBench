using System.Text.Json;

namespace MEditService.Core.Ledger;

/// <summary>
/// #416 comment 3 on the issue: the reduced-form journal, rebuilt against the recovery unit the
/// ADR-0041 amendment gives compile — <c>refs/medit/last-compile/&lt;plugin&gt;</c> — rather than
/// reusing the retired stage-1 journal (external <c>%LOCALAPPDATA%</c> storage, <c>LedgerGroupCommitter</c>,
/// change-group GUID keys — all gone with #410's hidden-gitdir layer).
///
/// <para><b>What a crash mid-batch can and cannot corrupt</b>: each individual plugin's own binary
/// write is already atomic by construction (temp-file-then-rename, <see cref="LedgerRepository.ParkCompileSnapshot"/>
/// only ever runs after that rename lands) — a crash can never leave one plugin's own binary/parked-ref
/// pair inconsistent with itself. What it *can* leave is a multi-plugin batch silently half-done: plugin
/// A compiled, plugin B didn't, and nothing says so — the user (or #417's dialog) has no way to tell
/// "everything in this Save & Compile landed" from "only some of it did". This class exists for that
/// gap alone.</para>
///
/// <para><b>Marker, not registry</b> — git's own idiom for an in-progress porcelain operation
/// (<c>.git/MERGE_MSG</c>, <c>.git/rebase-merge/</c>): a plain file inside the repo's own <c>.git</c>,
/// written before a batch starts, updated as each plugin's compile lands, and deleted when the whole
/// batch has. A multi-plugin batch can span mod folders (each mod folder is its own repo), so recovery
/// is per-repo by construction — one marker per <c>.git</c>, named by nothing but that folder.</para>
///
/// <para><b>Built, not wired</b> (#416 review): this ticket owns the primitive and its own tests; the
/// crash-repair loud offer (#381) and #417's dialog suppression are the callers that will read
/// <see cref="PendingRecovery"/>, on their own tickets.</para>
/// </summary>
public static class CompileJournal
{
    private const string MarkerFileName = "MEDIT_COMPILE_JOURNAL";

    private static string MarkerPath(string modFolder) => Path.Combine(modFolder, ".git", MarkerFileName);

    /// <summary>
    /// Runs <paramref name="compileOne"/> once per plugin in <paramref name="plugins"/>, journaling
    /// the batch around it: the marker is written before the first call (naming every plugin in the
    /// batch, none yet landed), rewritten after each successful compile (that plugin moves from
    /// pending to landed), and deleted only once every plugin has landed. A plugin that refuses
    /// (<paramref name="compileOne"/> returns <see langword="false"/>) stops the batch there — its own
    /// name, and everything after it, stays in the marker's pending set, which is exactly what a crash
    /// at that same point would also leave behind; the two cases are deliberately indistinguishable to
    /// a reader; both mean "some assumed the compiled state of this repo forward and it wasn't there".
    /// </summary>
    public static IReadOnlyList<string> RunBatch(
        string modFolder, IReadOnlyList<string> plugins, Func<string, bool> compileOne)
    {
        if (plugins.Count == 0) return [];

        WriteMarker(modFolder, plugins, landed: []);

        var landed = new List<string>();
        foreach (var plugin in plugins)
        {
            if (!compileOne(plugin)) break;

            landed.Add(plugin);
            WriteMarker(modFolder, plugins, landed);
        }

        if (landed.Count == plugins.Count)
            File.Delete(MarkerPath(modFolder));

        return landed;
    }

    /// <summary>
    /// A journal marker present in <paramref name="modFolder"/>'s repo, or null when the last batch
    /// (if any) completed cleanly — the one small public read #381's crash-repair offer and #417's
    /// external-change dialog both route on: a marker here means the mismatch between what's on disk
    /// and what the parked refs say is Modbench's own interrupted compile, not an external change.
    /// </summary>
    public static CompileJournalState? PendingRecovery(string modFolder)
    {
        var path = MarkerPath(modFolder);
        if (!File.Exists(path)) return null;

        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var plugins = ReadStringArray(doc.RootElement, "plugins");
        var landed = ReadStringArray(doc.RootElement, "landed");
        return new CompileJournalState(plugins, landed);
    }

    private static List<string> ReadStringArray(JsonElement root, string propertyName) =>
        root.GetProperty(propertyName).EnumerateArray().Select(e => e.GetString()!).ToList();

    private static void WriteMarker(string modFolder, IReadOnlyList<string> plugins, IReadOnlyList<string> landed)
    {
        var json = JsonSerializer.Serialize(new { plugins, landed });
        var path = MarkerPath(modFolder);

        // Same write-then-rename discipline as every other write this arc makes (RecordTextCodec,
        // PreparedPluginSave) — a marker that's itself torn by a second, unrelated crash mid-write
        // would defeat the entire point of having one.
        var tempPath = path + ".tmp";
        File.WriteAllText(tempPath, json);
        File.Move(tempPath, path, overwrite: true);
    }
}

/// <summary>A journal marker's content: every plugin the interrupted batch named, and which of them
/// had already landed. <see cref="Pending"/> is everything the batch didn't reach — recovery's own
/// job, never this record's.</summary>
public sealed record CompileJournalState(IReadOnlyList<string> Plugins, IReadOnlyList<string> Landed)
{
    public IReadOnlyList<string> Pending => [.. Plugins.Except(Landed, StringComparer.Ordinal)];
}
