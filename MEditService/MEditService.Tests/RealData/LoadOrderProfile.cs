using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Xunit.Abstractions;

namespace MEditService.Tests.RealData;

/// <summary>
/// The reconcile profiling harness. Loads a real MO2 instance's active profile exactly
/// the way the extension does (<c>modbench/src/modmanager/snapshot.ts</c>: plugins.txt order,
/// every line enabled or not, each name resolved overwrite → first enabled mod in modlist.txt order
/// → game Data folder) through <see cref="ILoadOrderMirror.Reconcile"/> <b>twice</b> — cold, then
/// dispose, then the identical order again over the index file the cold run left (a warm launch,
/// ADR-0001) — and aggregates the per-phase timing lines the load path logs into one report with
/// the two side by side (<see cref="LoadOrderProfileReport"/>): totals and phase split for both,
/// top plugins by cost and cost-per-record outliers for the cold run.
///
/// <para><b>Deletes the instance's index file first</b> (<see cref="IndexFile.For"/>), so the cold
/// number is honestly cold. That costs the instance one cold launch it would otherwise have skipped;
/// the file is left behind, freshly built, so the next real launch is warm.</para>
///
/// Environment-dependent and slow, so gated: set <c>MEDIT_PROFILE_INSTANCE</c> to the MO2 instance
/// root (the folder holding <c>ModOrganizer.ini</c>, <c>mods/</c>, <c>profiles/</c>). The game Data
/// folder is read from the ini's <c>gamePath</c> (a Wine path like <c>Z:\home\...</c> is unwrapped),
/// or set <c>MEDIT_PROFILE_DATA</c> explicitly. <c>MEDIT_PROFILE_OUT</c> names the report file
/// (default: <c>reconcile-profile.md</c> in the working directory). One measurement, not a
/// benchmark suite — run it alone, on a quiet machine.
/// </summary>
public sealed class LoadOrderProfile(ITestOutputHelper output)
{
    private sealed class ProfileFactAttribute : FactAttribute
    {
        public ProfileFactAttribute()
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MEDIT_PROFILE_INSTANCE")))
                Skip = "Set MEDIT_PROFILE_INSTANCE=<MO2 instance root> to run the load-order profile.";
        }
    }

    private sealed record ModEntry(string Name, bool Enabled);

    /// <summary>What the report needs from a load order, copied out before the mirror that holds it
    /// is disposed.</summary>
    internal sealed record HeldOrder(List<(string Name, int RecordCount)> Plugins, List<(string Name, string Reason)> Failures);

    [ProfileFact]
    public void ProfileReconcile()
    {
        var instanceRoot = Environment.GetEnvironmentVariable("MEDIT_PROFILE_INSTANCE")!;
        var ini = File.ReadAllLines(Path.Combine(instanceRoot, "ModOrganizer.ini"));
        var dataFolder = Environment.GetEnvironmentVariable("MEDIT_PROFILE_DATA")
            ?? Path.Combine(UnwrapWinePath(IniValue(ini, "gamePath")), "Data");
        var profile = IniValue(ini, "selected_profile");
        var profileDir = Path.Combine(instanceRoot, "profiles", profile);

        var plugins = ResolveExplicitPlugins(instanceRoot, profileDir, dataFolder);

        // The file and any write-ahead log a crashed run left beside it — a cold open that replays a
        // WAL is not cold.
        var indexPath = IndexFile.For(instanceRoot);
        foreach (var stale in new[] { indexPath, indexPath + ".wal" })
            if (File.Exists(stale)) File.Delete(stale);

        var cold = Measure(instanceRoot, dataFolder, plugins, out var loadOrder);
        var warm = Measure(instanceRoot, dataFolder, plugins, out _);

        var header = new ProfileHeader(instanceRoot, profile, dataFolder, plugins.Count, loadOrder.Plugins.Count, loadOrder.Failures.Count);
        var records = loadOrder.Plugins.ToDictionary(p => p.Name, p => p.RecordCount, StringComparer.OrdinalIgnoreCase);
        var report = LoadOrderProfileReport.Render(header, cold, warm, records, loadOrder.Failures);

        var outPath = Environment.GetEnvironmentVariable("MEDIT_PROFILE_OUT") ?? "load-order-profile.md";
        File.WriteAllText(outPath, report);
        output.WriteLine(report);
        output.WriteLine($"Report written to {Path.GetFullPath(outPath)}");
    }

    /// <summary>One reconcile over a fresh mirror, disposed before returning — so the second call is
    /// the next launch, not a same-process no-op reconcile.</summary>
    internal static ProfileRun Measure(string instanceRoot, string dataFolder, IReadOnlyList<LoadOrderEntry> plugins, out HeldOrder loadOrder)
    {
        var entries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        using var mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(
                SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance),
                loggerFactory.CreateLogger<DuckDbRecordIndexFactory>()),
            loggerFactory.CreateLogger<LoadOrderMirror>());

        var wall = Stopwatch.StartNew();
        ((ILoadOrderMirror)mirror).Reconcile(dataFolder, plugins, GameRelease.Fallout4, instanceRoot);
        wall.Stop();

        var held = mirror.LoadOrder!;
        loadOrder = new HeldOrder(
            held.Plugins.Select(p => (p.Name, p.RecordCount)).ToList(),
            held.LoadFailures.Select(f => (f.Name, f.Reason)).ToList());
        return ProfileRun.Parse(entries, wall.ElapsedMilliseconds);
    }

    // --- MO2 resolution, mirroring snapshot.ts ---

    private static List<LoadOrderEntry> ResolveExplicitPlugins(string instanceRoot, string profileDir, string dataFolder)
    {
        // modlist.txt: top line = highest priority; '+' enabled, '-' disabled, '*' separator.
        var modlist = File.ReadAllLines(Path.Combine(profileDir, "modlist.txt"))
            .Where(l => l.Length > 1 && (l[0] == '+' || l[0] == '-'))
            .Select(l => new ModEntry(l[1..], l[0] == '+'))
            .ToList();

        // Root-level files of each enabled mod, first (highest-priority) provider wins.
        var winnerByName = new Dictionary<string, (string Origin, string Path)>(StringComparer.OrdinalIgnoreCase);
        foreach (var mod in modlist.Where(m => m.Enabled))
        {
            var modDir = Path.Combine(instanceRoot, "mods", mod.Name);
            if (!Directory.Exists(modDir)) continue;
            foreach (var file in Directory.EnumerateFiles(modDir))
                winnerByName.TryAdd(Path.GetFileName(file), (mod.Name, file));
        }

        var overwriteDir = Path.Combine(instanceRoot, "overwrite");
        var overwriteFiles = Directory.Exists(overwriteDir)
            ? Directory.EnumerateFiles(overwriteDir).ToDictionary(f => Path.GetFileName(f)!, f => f, StringComparer.OrdinalIgnoreCase)
            : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var result = new List<LoadOrderEntry>();
        foreach (var raw in File.ReadAllLines(Path.Combine(profileDir, "plugins.txt")))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '#') continue;
            var participates = line[0] == '*';
            var name = participates ? line[1..] : line;

            if (overwriteFiles.TryGetValue(name, out var overwritePath))
                result.Add(new LoadOrderEntry(name, overwritePath, "overwrite", Slot: result.Count, Enabled: participates, Winning: true));
            else if (winnerByName.TryGetValue(name, out var winner))
                result.Add(new LoadOrderEntry(name, winner.Path, winner.Origin, Slot: result.Count, Enabled: participates, Winning: true));
            else
                result.Add(new LoadOrderEntry(name, Path.Combine(dataFolder, name), PluginOrigin.DataDirectory, Slot: result.Count, Enabled: participates, Winning: true));
        }
        return result;
    }

    private static string IniValue(string[] ini, string key)
    {
        var line = ini.First(l => l.StartsWith(key + " =", StringComparison.Ordinal) || l.StartsWith(key + "=", StringComparison.Ordinal));
        var value = line[(line.IndexOf('=') + 1)..].Trim();
        // @ByteArray(...) wrapper, doubled backslashes.
        if (value.StartsWith("@ByteArray(", StringComparison.Ordinal)) value = value["@ByteArray(".Length..^1];
        return value.Replace(@"\\", @"\");
    }

    private static string UnwrapWinePath(string path)
    {
        if (path.Length > 2 && path[1] == ':') path = path[2..]; // Z:\home\... → \home\...
        return path.Replace('\\', '/');
    }
}
